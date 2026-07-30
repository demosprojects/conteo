// app.js - Lógica principal del Terminal de Escaneo (multi-cliente)
import {
    onAuthChange,
    loginUsuario,
    logoutUsuario,
    escucharCatalogo,
    importarCatalogo,
    crearProducto,
    eliminarProducto,
    actualizarStockProducto,
    asegurarInventarioActual,
    escucharInventarioActual,
    cerrarInventario,
    actualizarItemInventario,
    eliminarItemInventario,
    obtenerInventariosCerrados,
    borrarCatalogoCompleto,
    borrarInventariosCompleto
} from './firebase.js';

let baseDeDatos = [];
let hasChanges = false;
let pendingProduct = null;
let pendingScanCode = null;
let currentUser = null;
let inventarioActual = null; // { id, nombre, estado, items }
let unsubCatalogo = null;    // función para dejar de escuchar el catálogo (onSnapshot)
let unsubInventario = null;  // función para dejar de escuchar el inventario actual (onSnapshot)

// Solo los productos que se modificaron en el conteo actual (para exportar el .txt)
const productosModificados = new Map();

// Stock que tenía cada producto ANTES de su primera modificación en este
// conteo (codigoArt -> stock original). Permite revertir un escaneo/edición
// por error desde "Modificaciones" sin perder el valor previo real.
const stockOriginalPorCodigo = new Map();

// Códigos de productos que se dieron de alta (nuevos) durante este conteo,
// no existían antes en el catálogo. No tienen "stock original" al que volver:
// eliminarlos borra el producto directamente.
const productosNuevosEnEsteConteo = new Set();

// Genera un código interno ESTABLE (no aleatorio) para productos sin código de
// barras, a partir de su descripción. El mismo producto siempre cae en el mismo
// código, sin importar cuántas veces se recargue el catálogo (caché, Firestore
// o el .txt) — así Firebase siempre encuentra/actualiza el mismo documento.
function codigoInternoDesdeDescripcion(descripcion) {
    const base = String(descripcion || '').trim().toUpperCase();
    let hash = 0;
    for (let i = 0; i < base.length; i++) {
        hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
    }
    return `SINCOD_${hash.toString(36)}`;
}

// Igual que codigoInternoDesdeDescripcion, pero además chequea que no choque
// con ningún código ya existente en el catálogo (por si dos productos tienen
// descripciones que generan el mismo hash). Usado al dar de alta un producto
// nuevo manualmente, sin código de barras.
function generarCodigoInternoUnico(descripcion) {
    const base = codigoInternoDesdeDescripcion(descripcion);
    let candidato = base;
    let n = 2;
    while (baseDeDatos.some(p => p.codigoArt === candidato)) {
        candidato = `${base}_${n}`;
        n++;
    }
    return candidato;
}

// Asegura que un producto tenga codigoArt no vacío, usando el código interno
// estable si hace falta. Se aplica en TODOS los puntos donde el catálogo entra
// a memoria (caché local, Firestore, importación de .txt).
function normalizarCodigoProducto(producto) {
    const codigo = String(producto.codigoArt ?? '').trim();
    if (codigo === '') {
        producto.codigoArt = codigoInternoDesdeDescripcion(producto.articulo);
    }
    return producto;
}

// -------------------------------
// Toasts
// -------------------------------
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 200);
    }, 3200);
}

// -------------------------------
// Generación y descarga de .txt (reutilizado por el avance parcial,
// la finalización del conteo, y el historial)
// -------------------------------

// Recibe una lista de items ya "canónicos": {registrado, hora, codigo, descripcion, unidades, stock}
function generarContenidoTxt(items) {
    let contenido = '';
    items.forEach(it => {
        contenido += `${it.registrado || ''};${it.hora || ''};${it.codigo};${it.descripcion};${it.unidades};${it.stock};\n`;
    });
    return contenido;
}

function descargarTxt(contenido, nombreArchivo) {
    const blob = new Blob([contenido], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nombreArchivo;
    a.click();
    URL.revokeObjectURL(url);
}

// Convierte los productos modificados en memoria (shape de baseDeDatos) al
// formato canónico que usa generarContenidoTxt.
function productosModificadosACanonico() {
    return Array.from(productosModificados.values()).map(p => ({
        registrado: p.registrado,
        hora: p.hora,
        codigo: p.codigoArt,
        descripcion: p.articulo,
        unidades: p.unidades,
        stock: p.stock_unidad
    }));
}

// -------------------------------
// 0. Autenticación
// -------------------------------
const loginScreen = document.getElementById('loginScreen');
const appRoot = document.getElementById('appRoot');
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');
const loginSubmitBtn = document.getElementById('loginSubmitBtn');

loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    loginError.classList.remove('show');
    loginSubmitBtn.disabled = true;
    loginSubmitBtn.textContent = 'Ingresando…';

    try {
        await loginUsuario(email, password);
        // onAuthChange se encarga de mostrar la app
    } catch (err) {
        console.error(err);
        loginError.textContent = 'No pudimos iniciar sesión. Revisá el email y la contraseña.';
        loginError.classList.add('show');
    } finally {
        loginSubmitBtn.disabled = false;
        loginSubmitBtn.textContent = 'Ingresar';
    }
});

document.getElementById('logoutBtn').addEventListener('click', function () {
    logoutUsuario();
});

// -------------------------------
// 0b. Navegación por páginas (Escanear / Productos / Conteo / Más)
// -------------------------------
const bottomNav = document.getElementById('bottomNav');
const paginas = ['escanear', 'productos', 'conteo', 'mas'];

function activarPagina(nombre) {
    if (!paginas.includes(nombre)) nombre = 'escanear';

    paginas.forEach(p => {
        document.getElementById('page' + p.charAt(0).toUpperCase() + p.slice(1))
            .classList.toggle('is-active', p === nombre);
    });

    bottomNav.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.page === nombre);
    });

    // Si nos vamos de la página de escaneo, apagamos la cámara para no
    // gastar batería/datos de fondo.
    if (nombre !== 'escanear' && isScanning) {
        detenerCamara();
    }

    // Si entramos a "Más" y todavía no se buscó nada, precargamos el rango de
    // hoy y disparamos la búsqueda: así en la PC del mostrador el historial
    // aparece solo, sin tener que tocar fechas ni el botón "Buscar conteos".
    if (nombre === 'mas' && currentUser) {
        const histDesde = document.getElementById('histDesde');
        const histHasta = document.getElementById('histHasta');
        if (!histDesde.value && !histHasta.value) {
            const ahora = new Date();
            const hoy = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}-${String(ahora.getDate()).padStart(2, '0')}`;
            histDesde.value = hoy;
            histHasta.value = hoy;
            buscarHistorial();
        }
    }

    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

bottomNav.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => activarPagina(btn.dataset.page));
});

function actualizarBadgeConteo() {
    const badge = document.getElementById('navConteoBadge');
    const cantidad = productosModificados.size;
    badge.textContent = cantidad > 99 ? '99+' : String(cantidad);
    badge.style.display = cantidad > 0 ? '' : 'none';
}

onAuthChange(async function (user) {
    currentUser = user;

    if (user) {
        loginScreen.classList.add('is-hidden');
        appRoot.classList.remove('is-hidden');
        document.getElementById('userChip').textContent = user.email;

        const params = new URLSearchParams(location.search);
        document.getElementById('dangerZone').style.display = params.get('reset') === '1' ? '' : 'none';

        await inicializarSesion(user.uid);
    } else {
        appRoot.classList.add('is-hidden');
        loginScreen.classList.remove('is-hidden');
        resetEstadoApp();
    }
});

async function inicializarSesion(uid) {
    let primeraFotoCatalogo = true;

    // Catálogo: un único listener en tiempo real por sesión. Cada vez que
    // CUALQUIER dispositivo logueado con esta cuenta da de alta, edita o
    // borra un producto, este callback se dispara solo en TODOS los
    // dispositivos conectados — no hace falta tocar ningún botón de
    // sincronizar, y todos terminan mostrando siempre el mismo número de
    // productos.
    unsubCatalogo = escucharCatalogo(uid, (catalogo) => {
        baseDeDatos = catalogo.map(p => normalizarCodigoProducto({
            registrado: '',
            hora: '',
            codigoArt: p.codigo,
            articulo: p.descripcion || '(sin descripción)',
            unidades: p.unidades || '',
            stock_unidad: p.stock || 0
        }));

        if (baseDeDatos.length > 0) {
            mostrarCatalogoListo();
        } else {
            mostrarCargaInicial();
        }

        // Reordenamos la tabla de "Modificaciones" con el stock más fresco
        // por si cambió algo mientras el conteo estaba abierto.
        if (inventarioActual) {
            sincronizarItemsDesdeInventario(inventarioActual.items || {});
        }

        if (primeraFotoCatalogo) {
            primeraFotoCatalogo = false;
            activarPagina(baseDeDatos.length === 0 ? 'productos' : 'escanear');
        }
    }, () => {
        showToast('No se pudo sincronizar el catálogo. Revisá tu conexión.', 'error');
    });

    // Inventario "actual": mismo esquema. Al ID fijo (uid + "_actual") todos
    // los dispositivos apuntan al mismo documento, así que un escaneo hecho
    // desde el celular aparece también en la PC, y viceversa, sin recargar.
    try {
        await asegurarInventarioActual(uid);
    } catch (err) {
        console.error(err);
        showToast('No se pudo abrir el inventario del día.', 'error');
    }

    unsubInventario = escucharInventarioActual(uid, (inv) => {
        if (!inv) return; // todavía no se creó / se está creando
        inventarioActual = inv;
        renderInventarioBar();
        sincronizarItemsDesdeInventario(inv.items || {});
    }, () => {
        showToast('No se pudo sincronizar el inventario. Revisá tu conexión.', 'error');
    });
}

function resetEstadoApp() {
    if (unsubCatalogo) { unsubCatalogo(); unsubCatalogo = null; }
    if (unsubInventario) { unsubInventario(); unsubInventario = null; }

    baseDeDatos = [];
    hasChanges = false;
    productosModificados.clear();
    stockOriginalPorCodigo.clear();
    productosNuevosEnEsteConteo.clear();
    actualizarBadgeConteo();
    inventarioActual = null;
    document.getElementById('scannedTable').innerHTML = '<tr><td colspan="4" class="empty-row">No hay modificaciones recientes</td></tr>';
    productsSearchInput.value = '';
    productsTableBody.innerHTML = '<tr><td colspan="3" class="empty-row">Subí el catálogo para ver los productos</td></tr>';
    resetHistorial();
    deshabilitarEscaneo();
    const dbStatus = document.getElementById('dbStatus');
    dbStatus.innerText = 'Sin productos · 0 productos';
    dbStatus.classList.remove('is-ready');
    if (isScanning) detenerCamara();
    activarPagina('escanear');
}

// -------------------------------
// 1. Catálogo (colección "productos" en Firestore)
// -------------------------------
function mostrarCatalogoListo() {
    const dbStatus = document.getElementById('dbStatus');
    dbStatus.innerText = `Productos cargados · ${baseDeDatos.length} productos`;
    dbStatus.classList.add('is-ready');

    document.getElementById('catalogUploadPanel').style.display = 'none';
    document.getElementById('catalogStatus').style.display = 'flex';
    document.getElementById('catalogCount').textContent = baseDeDatos.length;

    habilitarEscaneo();
    renderTablaProductos();
    actualizarEstadoDescarga();
}

function mostrarCargaInicial() {
    const dbStatus = document.getElementById('dbStatus');
    dbStatus.innerText = 'Sin productos · subí el catálogo inicial';
    dbStatus.classList.remove('is-ready');

    document.getElementById('catalogUploadPanel').style.display = '';
    document.getElementById('catalogStatus').style.display = 'none';

    deshabilitarEscaneo();
    actualizarEstadoDescarga();
}

function habilitarEscaneo() {
    document.getElementById('scannerInput').disabled = false;
    document.getElementById('buscarArticuloInput').disabled = false;
    document.getElementById('startCameraBtn').disabled = false;
    document.getElementById('downloadBtn').disabled = false;
}

function deshabilitarEscaneo() {
    document.getElementById('scannerInput').disabled = true;
    document.getElementById('buscarArticuloInput').disabled = true;
    document.getElementById('startCameraBtn').disabled = true;
    document.getElementById('downloadBtn').disabled = true;
}

// -------------------------------
// 1b. Estado de sincronización: ahora es automático (listeners en tiempo
// real de Firestore), así que el botón "Finalizar" se habilita apenas hay
// catálogo e inventario cargados — ya no hace falta un paso manual de
// "Sincronizar" antes de poder finalizar/descargar.
// -------------------------------
function actualizarEstadoDescarga() {
    const nuevoInventarioBtn = document.getElementById('nuevoInventarioBtn');
    const syncBadge = document.getElementById('syncBadge');

    nuevoInventarioBtn.disabled = !(baseDeDatos.length > 0 && inventarioActual);

    if (syncBadge) {
        syncBadge.textContent = 'Sincronizado';
        syncBadge.classList.add('is-synced');
    }
}

// Los botones "Sincronizar" quedan como acción manual opcional: con los
// listeners en tiempo real ya no hace falta tocarlos para que los datos
// estén al día, pero los dejamos funcionando (por si alguien los toca por
// costumbre, o para forzar un refresco visual de la tabla).
document.getElementById('sincronizarCatalogoBtn').addEventListener('click', function () {
    renderTablaProductos();
    showToast('El catálogo ya se sincroniza solo en tiempo real. Esto está al día.', 'info');
});

document.getElementById('sincronizarConteoBtn').addEventListener('click', function () {
    if (inventarioActual) sincronizarItemsDesdeInventario(inventarioActual.items || {});
    showToast('El conteo ya se sincroniza solo en tiempo real. Esto está al día.', 'info');
});

document.getElementById('fileInput').addEventListener('change', function (e) {
    const file = e.target.files[0];
    if (!file || !currentUser) return;

    // El .txt es SOLO para la carga inicial. Si ya hay catálogo cargado en esta
    // cuenta, no se vuelve a usar: los cambios se manejan desde la app y se
    // exportan con el botón de descarga.
    if (baseDeDatos.length > 0) {
        showToast('El catálogo ya está cargado. El .txt solo se usa para la carga inicial; los cambios se manejan desde acá.', 'error');
        e.target.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = function (e) {
        parseTxtYSubir(e.target.result);
    };
    reader.readAsText(file);
});

// Parsea el .txt (separado por ';') y sube el catálogo inicial a Firestore
async function parseTxtYSubir(text) {
    const lines = text.split('\n');
    const productos = [];
    let sinCodigoCount = 0;

    lines.forEach(line => {
        if (line.trim() === '') return;
        const cols = line.split(';');

        // La estructura es: Registrado;Hora;CodigoArt;Artículo;Unidades;Stock_Unidad;
        if (cols.length >= 6) {
            // Algunos productos vienen sin código de barras (columna vacía).
            // Firestore no admite IDs de documento ni field paths vacíos, así que
            // les generamos un código interno ESTABLE (basado en la descripción)
            // para que nunca quede "" y sea el mismo aunque reimportes el archivo.
            let codigoArt = (cols[2] || '').trim();
            if (codigoArt === '') {
                sinCodigoCount++;
                codigoArt = codigoInternoDesdeDescripcion(cols[3]);
            }

            productos.push({
                registrado: cols[0],
                hora: cols[1],
                codigoArt,
                articulo: cols[3],
                unidades: cols[4],
                stock_unidad: parseInt(cols[5]) || 0
            });
        }
    });

    if (sinCodigoCount > 0) {
        showToast(`${sinCodigoCount} producto(s) sin código de barras: se les asignó un código interno.`, 'info');
    }

    if (productos.length === 0) {
        showToast('El archivo no tiene productos con el formato esperado.', 'error');
        return;
    }

    showToast('Subiendo catálogo, puede tardar unos segundos…', 'info');

    try {
        await importarCatalogo(currentUser.uid, productos);
        // No hace falta tocar baseDeDatos ni caché a mano: el listener en
        // tiempo real de escucharCatalogo() va a traer estos productos solo,
        // en todos los dispositivos conectados.
        mostrarCatalogoListo();
        showToast(`Catálogo cargado: ${productos.length} productos.`, 'success');
        activarPagina('escanear');
    } catch (err) {
        console.error(err);
        showToast('No se pudo subir el catálogo.', 'error');
    }
}

// -------------------------------
// 2. Inventario del día (colección "inventarios")
// -------------------------------
function renderInventarioBar() {
    document.getElementById('invName').textContent = inventarioActual.nombre;
    document.getElementById('invState').textContent = inventarioActual.estado;
}

// Reconstruye por completo la tabla de "Modificaciones" y el Map en memoria
// (productosModificados) a partir del mapa "items" del inventario actual en
// Firestore. Se llama cada vez que llega una actualización del listener en
// tiempo real (escucharInventarioActual), no solo al arrancar la sesión —
// así, si escaneás un producto desde el celular, aparece solo en la tabla de
// la PC (y viceversa), sin recargar la página. También se llama con un mapa
// vacío al finalizar un conteo, para limpiar la tabla en todos los
// dispositivos apenas se cierra.
function sincronizarItemsDesdeInventario(items) {
    const entradas = Object.values(items || {});
    const tbody = document.getElementById('scannedTable');

    productosModificados.clear();
    tbody.innerHTML = '';

    if (entradas.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-row">No hay modificaciones recientes</td></tr>';
        actualizarBadgeConteo();
        return;
    }

    entradas.forEach(item => {
        const tr = document.createElement('tr');
        tr.dataset.codigo = item.codigo;
        tr.innerHTML = `
            <td class="time-cell">${item.hora || '—'}</td>
            <td>${item.descripcion}<span class="product-code">${item.codigo}</span></td>
            <td class="stock-cell">${item.stock}</td>
            <td class="action-cell"><button type="button" class="row-delete-btn" data-accion="eliminar" title="Revertir / eliminar">✕</button></td>
        `;
        tbody.appendChild(tr);

        // Preferimos el producto tal como está en baseDeDatos (catálogo ya
        // sincronizado) para que el .txt final salga con el stock más
        // fresco; si por algún motivo todavía no llegó al catálogo local,
        // usamos directamente lo que dice el item del inventario.
        const producto = baseDeDatos.find(p => p.codigoArt === item.codigo) || {
            codigoArt: item.codigo,
            articulo: item.descripcion,
            unidades: item.unidades,
            stock_unidad: item.stock,
            registrado: '',
            hora: ''
        };
        productosModificados.set(item.codigo, producto);
    });
    actualizarBadgeConteo();
    hasChanges = true;
}

document.getElementById('scannedTable').addEventListener('click', async function (e) {
    const fila = e.target.closest('tr[data-codigo]');
    if (!fila) return;
    const codigo = fila.dataset.codigo;

    // Click en el botón "✕": revertir la modificación o borrar el producto.
    if (e.target.closest('[data-accion="eliminar"]')) {
        await eliminarModificacion(codigo, fila);
        return;
    }

    // Click en cualquier otro lugar de la fila: abrir modal para corregir el stock.
    const producto = baseDeDatos.find(p => p.codigoArt === codigo);
    if (!producto) {
        showToast('No se encontró este producto en el catálogo para editarlo.', 'error');
        return;
    }
    abrirModalCantidad(producto, 'editar');
});

// Revierte una fila de "Modificaciones": si el producto ya existía en el
// catálogo, vuelve su stock al valor previo a este conteo; si se dio de alta
// recién en este conteo, lo borra directamente (nunca existió antes).
async function eliminarModificacion(codigo, fila) {
    if (!currentUser) return;

    const esNuevo = productosNuevosEnEsteConteo.has(codigo);
    const producto = baseDeDatos.find(p => p.codigoArt === codigo);
    const nombre = producto ? producto.articulo : codigo;

    const mensaje = esNuevo
        ? `"${nombre}" se dio de alta en este conteo. Se va a borrar del catálogo por completo. ¿Confirmás?`
        : `Se va a revertir el stock de "${nombre}" al valor que tenía antes de este conteo y se va a sacar de la lista. ¿Confirmás?`;
    const confirmado = await mostrarConfirm({
        titulo: esNuevo ? 'Eliminar producto' : 'Revertir modificación',
        mensaje,
        textoConfirmar: esNuevo ? 'Eliminar' : 'Revertir'
    });
    if (!confirmado) return;

    fila.remove();
    productosModificados.delete(codigo);
    actualizarBadgeConteo();
    if (productosModificados.size === 0) {
        document.getElementById('scannedTable').innerHTML = '<tr><td colspan="4" class="empty-row">No hay modificaciones recientes</td></tr>';
        hasChanges = false;
    }

    try {
        if (esNuevo) {
            baseDeDatos = baseDeDatos.filter(p => p.codigoArt !== codigo);
            productosNuevosEnEsteConteo.delete(codigo);
            await eliminarProducto(currentUser.uid, codigo);
            document.getElementById('catalogCount').textContent = baseDeDatos.length;
            document.getElementById('dbStatus').innerText = `Productos cargados · ${baseDeDatos.length} productos`;
            renderTablaProductos();
        } else if (producto) {
            if (stockOriginalPorCodigo.has(codigo)) {
                producto.stock_unidad = stockOriginalPorCodigo.get(codigo);
                stockOriginalPorCodigo.delete(codigo);
                await actualizarStockProducto(currentUser.uid, producto);
                renderTablaProductos();
            } else {
                // Producto que ya venía modificado de una sesión anterior (se
                // recargó la página): no tenemos el valor previo real, así
                // que solo lo sacamos de la lista sin tocar el stock actual.
                showToast('No se pudo recuperar el valor anterior (era de otra sesión); solo se sacó de la lista.', 'info');
            }
        }

        if (inventarioActual) {
            await eliminarItemInventario(inventarioActual.id, codigo);
        }
        showToast(esNuevo ? `"${nombre}" eliminado.` : `"${nombre}" revertido.`, 'success');
    } catch (err) {
        console.error(err);
        showToast('Hubo un problema al sincronizar la reversión.', 'error');
    }
}

document.getElementById('nuevoInventarioBtn').addEventListener('click', async function () {
    if (!currentUser || !inventarioActual) return;

    const cantidad = productosModificados.size;
    const mensajeConfirmar = cantidad > 0
        ? `Se va a cerrar este conteo con ${cantidad} producto(s) modificado(s). ¿Confirmás?`
        : 'No modificaste ningún producto en este conteo. ¿Igual querés finalizarlo?';
    const confirmado = await mostrarConfirm({
        titulo: 'Finalizar conteo',
        mensaje: mensajeConfirmar,
        textoConfirmar: 'Finalizar'
    });
    if (!confirmado) return;

    // Descargar el .txt en este dispositivo es opcional: normalmente el conteo
    // se hace desde el celular y el .txt se termina bajando desde la PC del
    // mostrador (pestaña "Más" → Historial), así que preguntamos en vez de
    // descargar siempre.
    const descargarAca = cantidad > 0 && await mostrarConfirm({
        titulo: 'Descargar .txt',
        mensaje: '¿Querés descargar el .txt en este dispositivo también?\n\n(Si vas a bajarlo después desde la PC del mostrador, podés tocar "Cancelar").',
        textoConfirmar: 'Descargar'
    });

    try {
        if (descargarAca) {
            descargarTxt(generarContenidoTxt(productosModificadosACanonico()), 'inventario_actualizado.txt');
        }

        // cerrarInventario archiva el conteo actual en el Historial y
        // resetea el mismo documento "actual" para el próximo conteo, todo
        // en una transacción atómica. No hace falta crear nada a mano: el
        // listener de escucharInventarioActual va a recibir el reseteo solo
        // (en este dispositivo y en cualquier otro conectado) y va a limpiar
        // la tabla de "Modificaciones" automáticamente.
        await cerrarInventario(currentUser.uid);
        stockOriginalPorCodigo.clear();
        productosNuevosEnEsteConteo.clear();
        showToast('Conteo finalizado. Nuevo conteo iniciado.', 'success');
    } catch (err) {
        console.error(err);
        showToast('No se pudo finalizar el conteo.', 'error');
    }
});

async function sincronizarItemInventario(producto) {
    if (!inventarioActual) return;
    const horaActual = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const ok = await actualizarItemInventario(inventarioActual.id, producto.codigoArt, {
        codigo: producto.codigoArt,
        descripcion: producto.articulo,
        unidades: producto.unidades,
        stock: producto.stock_unidad,
        hora: horaActual
    });
    if (!ok) {
        showToast(`No se pudo sincronizar "${producto.articulo}" con el inventario.`, 'error');
    }
}

// -------------------------------
// 3. Tabs: Cámara / Código / Por nombre
// -------------------------------
const tabCamera = document.getElementById('tabCamera');
const tabManual = document.getElementById('tabManual');
const tabBuscar = document.getElementById('tabBuscar');
const panelCamera = document.getElementById('panelCamera');
const panelManual = document.getElementById('panelManual');
const panelBuscar = document.getElementById('panelBuscar');

function activarTab(nombre) {
    tabCamera.classList.toggle('is-active', nombre === 'camera');
    tabManual.classList.toggle('is-active', nombre === 'manual');
    tabBuscar.classList.toggle('is-active', nombre === 'buscar');

    panelCamera.style.display = nombre === 'camera' ? '' : 'none';
    panelManual.style.display = nombre === 'manual' ? '' : 'none';
    panelBuscar.style.display = nombre === 'buscar' ? '' : 'none';

    if (nombre !== 'camera' && isScanning) {
        detenerCamara();
    }
}

tabCamera.addEventListener('click', () => activarTab('camera'));
tabManual.addEventListener('click', () => {
    activarTab('manual');
    const input = document.getElementById('scannerInput');
    if (!input.disabled) input.focus();
});
tabBuscar.addEventListener('click', () => {
    activarTab('buscar');
    const input = document.getElementById('buscarArticuloInput');
    if (!input.disabled) input.focus();
});

// -------------------------------
// 4. Escaneo manual (teclado / lector físico tipo teclado)
// -------------------------------
document.getElementById('scannerInput').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        const codigoEscaneado = this.value.trim();
        if (codigoEscaneado !== '') {
            procesarEscaneo(codigoEscaneado);
        }
        this.value = '';
    }
});

// Solo permite números (los códigos de barra son numéricos). Filtra tanto
// lo tipeado como lo pegado, sin importar el origen (teclado, lector físico, etc.).
document.getElementById('scannerInput').addEventListener('input', function () {
    const limpio = this.value.replace(/\D/g, '');
    if (limpio !== this.value) this.value = limpio;
});

// -------------------------------
// 4b. Búsqueda manual por nombre de artículo (para productos sin código de barra)
// -------------------------------
const buscarArticuloInput = document.getElementById('buscarArticuloInput');
const buscarResultados = document.getElementById('buscarResultados');

function normalizarTexto(texto) {
    return String(texto)
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // saca acentos
}

buscarArticuloInput.addEventListener('input', function () {
    const textoOriginal = this.value.trim();
    const termino = normalizarTexto(textoOriginal);

    if (termino.length < 2) {
        buscarResultados.innerHTML = '';
        buscarResultados.classList.remove('has-items');
        return;
    }

    const coincidencias = baseDeDatos
        .filter(p => normalizarTexto(p.articulo).includes(termino))
        .slice(0, 25);

    renderResultadosBusqueda(coincidencias, textoOriginal);
});

function renderResultadosBusqueda(productos, textoBuscado) {
    buscarResultados.classList.add('has-items');

    if (productos.length === 0) {
        buscarResultados.innerHTML = '';

        const sinResultados = document.createElement('div');
        sinResultados.className = 'buscar-sin-resultados';
        sinResultados.textContent = 'No se encontró ningún producto con ese nombre.';
        buscarResultados.appendChild(sinResultados);

        const btnAgregar = document.createElement('button');
        btnAgregar.type = 'button';
        btnAgregar.className = 'btn btn--ghost btn--full';
        btnAgregar.textContent = `Agregar "${textoBuscado}" como producto nuevo (sin código de barras)`;
        btnAgregar.addEventListener('click', () => {
            abrirModalProductoNuevo(null, textoBuscado);
            buscarArticuloInput.value = '';
            buscarResultados.innerHTML = '';
            buscarResultados.classList.remove('has-items');
        });
        buscarResultados.appendChild(btnAgregar);
        return;
    }

    buscarResultados.innerHTML = '';
    productos.forEach(producto => {
        const fila = document.createElement('div');
        fila.className = 'buscar-item';
        fila.innerHTML = `
            <span class="buscar-item-nombre">${producto.articulo}<span class="buscar-item-codigo">${producto.codigoArt}</span></span>
            <span class="buscar-item-stock">${producto.stock_unidad}</span>
        `;
        fila.addEventListener('click', () => {
            abrirModalCantidad(producto);
            buscarArticuloInput.value = '';
            buscarResultados.innerHTML = '';
            buscarResultados.classList.remove('has-items');
        });
        buscarResultados.appendChild(fila);
    });
}

// -------------------------------
// 4c. Listado completo del catálogo ("Todos los productos")
// -------------------------------
const productsSearchInput = document.getElementById('productsSearchInput');
const productsTableBody = document.getElementById('productsTableBody');

function renderTablaProductos() {
    const termino = normalizarTexto(productsSearchInput.value.trim());

    if (baseDeDatos.length === 0) {
        productsTableBody.innerHTML = '<tr><td colspan="3" class="empty-row">Subí el catálogo para ver los productos</td></tr>';
        return;
    }

    const lista = termino.length === 0
        ? baseDeDatos
        : baseDeDatos.filter(p =>
            normalizarTexto(p.articulo).includes(termino) ||
            normalizarTexto(p.codigoArt).includes(termino)
        );

    if (lista.length === 0) {
        productsTableBody.innerHTML = '<tr><td colspan="3" class="empty-row">No se encontró ningún producto con ese criterio</td></tr>';
        return;
    }

    const ordenada = [...lista].sort((a, b) => String(a.articulo || '').localeCompare(String(b.articulo || ''), 'es'));

    productsTableBody.innerHTML = '';
    ordenada.forEach(producto => {
        const tr = document.createElement('tr');
        tr.dataset.codigo = producto.codigoArt;
        tr.innerHTML = `
            <td>${producto.articulo}<span class="product-code">${producto.codigoArt}</span></td>
            <td class="stock-cell">${producto.stock_unidad}</td>
            <td class="action-cell"><button type="button" class="row-delete-btn" data-accion="eliminar-producto" title="Eliminar para siempre">✕</button></td>
        `;
        productsTableBody.appendChild(tr);
    });
}

productsSearchInput.addEventListener('input', renderTablaProductos);

productsTableBody.addEventListener('click', async function (e) {
    const fila = e.target.closest('tr[data-codigo]');
    if (!fila) return;
    const codigo = fila.dataset.codigo;

    if (e.target.closest('[data-accion="eliminar-producto"]')) {
        await eliminarProductoDelCatalogo(codigo);
        return;
    }

    const producto = baseDeDatos.find(p => p.codigoArt === codigo);
    if (producto) abrirModalCantidad(producto, 'editar');
});

// Borra un producto del catálogo para siempre, desde la pestaña "Productos".
// A diferencia del "eliminar" de Modificaciones, esto no revierte nada: el
// producto deja de existir en el catálogo (Firestore + local).
async function eliminarProductoDelCatalogo(codigo) {
    if (!currentUser) return;
    const producto = baseDeDatos.find(p => p.codigoArt === codigo);
    const nombre = producto ? producto.articulo : codigo;

    const confirmado = await mostrarConfirm({
        titulo: 'Eliminar producto',
        mensaje: `Se va a borrar "${nombre}" del catálogo para siempre. Esta acción no se puede deshacer. ¿Confirmás?`,
        textoConfirmar: 'Eliminar'
    });
    if (!confirmado) return;

    try {
        await eliminarProducto(currentUser.uid, codigo);
        baseDeDatos = baseDeDatos.filter(p => p.codigoArt !== codigo);
        productosModificados.delete(codigo);
        stockOriginalPorCodigo.delete(codigo);
        productosNuevosEnEsteConteo.delete(codigo);
        document.getElementById('catalogCount').textContent = baseDeDatos.length;
        document.getElementById('dbStatus').innerText = `Productos cargados · ${baseDeDatos.length} productos`;
        renderTablaProductos();
        actualizarBadgeConteo();
        showToast(`"${nombre}" eliminado del catálogo.`, 'success');
    } catch (err) {
        console.error(err);
        showToast('No se pudo eliminar el producto.', 'error');
    }
}

// -------------------------------
// 5. Escaneo por cámara (html5-qrcode)
// -------------------------------
let html5QrCode = null;
let isScanning = false;
let lastScan = { code: null, time: 0 };

const startCameraBtn = document.getElementById('startCameraBtn');
const stopCameraBtn = document.getElementById('stopCameraBtn');
const cameraWrap = document.getElementById('cameraWrap');

const FORMATOS_CODIGO_BARRAS = (typeof Html5QrcodeSupportedFormats !== 'undefined') ? [
    Html5QrcodeSupportedFormats.CODE_128,
    Html5QrcodeSupportedFormats.CODE_39,
    Html5QrcodeSupportedFormats.CODE_93,
    Html5QrcodeSupportedFormats.EAN_13,
    Html5QrcodeSupportedFormats.EAN_8,
    Html5QrcodeSupportedFormats.UPC_A,
    Html5QrcodeSupportedFormats.UPC_E,
    Html5QrcodeSupportedFormats.CODABAR,
    Html5QrcodeSupportedFormats.ITF,
    Html5QrcodeSupportedFormats.QR_CODE
] : undefined;

startCameraBtn.addEventListener('click', iniciarCamara);
stopCameraBtn.addEventListener('click', detenerCamara);

async function iniciarCamara() {
    if (typeof Html5Qrcode === 'undefined') {
        showToast('No se pudo cargar el módulo de cámara. Verificá tu conexión a internet.', 'error');
        return;
    }

    try {
        const devices = await Html5Qrcode.getCameras();
        if (!devices || devices.length === 0) {
            showToast('No se encontró ninguna cámara disponible. Usá la carga manual.', 'error');
            activarTab('manual');
            return;
        }

        const trasera = devices.find(d => /back|rear|environment/i.test(d.label));
        const cameraId = trasera ? trasera.id : devices[devices.length - 1].id;

        html5QrCode = new Html5Qrcode('cameraView', {
            formatsToSupport: FORMATOS_CODIGO_BARRAS,
            verbose: false
        });

        await html5QrCode.start(
            cameraId,
            {
                fps: 10,
                qrbox: { width: 280, height: 140 }
            },
            onScanSuccess,
            () => { /* fallo de lectura en un frame puntual: se ignora */ }
        );

        isScanning = true;
        cameraWrap.classList.add('is-scanning');
        startCameraBtn.style.display = 'none';
        stopCameraBtn.style.display = '';

    } catch (err) {
        console.error(err);
        showToast('No se pudo acceder a la cámara. Revisá los permisos o usá la carga manual.', 'error');
        activarTab('manual');
    }
}

async function detenerCamara() {
    if (html5QrCode && isScanning) {
        try {
            await html5QrCode.stop();
            html5QrCode.clear();
        } catch (err) {
            console.error(err);
        }
    }
    isScanning = false;
    cameraWrap.classList.remove('is-scanning');
    startCameraBtn.style.display = '';
    stopCameraBtn.style.display = 'none';
}

function onScanSuccess(decodedText) {
    const ahora = Date.now();
    if (decodedText === lastScan.code && ahora - lastScan.time < 2500) return;
    lastScan = { code: decodedText, time: ahora };

    if (navigator.vibrate) navigator.vibrate(80);
    procesarEscaneo(decodedText);
}

// -------------------------------
// 6. Procesar código escaneado (cámara o manual)
// -------------------------------
function procesarEscaneo(codigo) {
    const producto = baseDeDatos.find(p => p.codigoArt === codigo);

    if (producto) {
        abrirModalCantidad(producto);
    } else {
        abrirModalProductoNuevo(codigo);
    }
}

// -------------------------------
// 7. Modal de cantidad (producto ya conocido)
// -------------------------------
const qtyModal = document.getElementById('qtyModal');
const qtyInput = document.getElementById('qtyInput');
const qtyModalModeBadge = document.getElementById('qtyModalModeBadge');
const qtyModalHint = document.getElementById('qtyModalHint');
const qtyConfirmBtn = document.getElementById('qtyConfirm');

let modoModalCantidad = 'sumar'; // 'sumar' (delta al escanear) | 'editar' (fijar stock exacto)

function abrirModalCantidad(producto, modo = 'sumar') {
    pendingProduct = producto;
    modoModalCantidad = modo;

    document.getElementById('qtyModalProductName').textContent = producto.articulo;
    document.getElementById('qtyModalProductCode').textContent = producto.codigoArt;
    document.getElementById('qtyModalCurrentStock').textContent = producto.stock_unidad;

    if (modo === 'editar') {
        qtyModalModeBadge.textContent = 'Editar producto';
        qtyModalModeBadge.classList.add('is-editing');
        qtyModalHint.textContent = 'Corregí el stock: escribí el número final (no se suma, reemplaza el valor actual).';
        qtyConfirmBtn.textContent = 'Guardar corrección';
        qtyInput.value = producto.stock_unidad;
    } else {
        qtyModalModeBadge.textContent = 'Sumar / restar';
        qtyModalModeBadge.classList.remove('is-editing');
        qtyModalHint.textContent = 'Ingresá cuánto sumar o restar (usá números negativos para restar).';
        qtyConfirmBtn.textContent = 'Confirmar';
        qtyInput.value = 1;
    }

    qtyModal.classList.add('open');
    setTimeout(() => { qtyInput.focus(); qtyInput.select(); }, 50);
}

function cerrarModalCantidad() {
    qtyModal.classList.remove('open');
    pendingProduct = null;
    modoModalCantidad = 'sumar';
}

document.getElementById('qtyMinus').addEventListener('click', () => {
    qtyInput.value = (parseInt(qtyInput.value, 10) || 0) - 1;
});
document.getElementById('qtyPlus').addEventListener('click', () => {
    qtyInput.value = (parseInt(qtyInput.value, 10) || 0) + 1;
});
document.getElementById('qtyCancel').addEventListener('click', cerrarModalCantidad);

document.getElementById('qtyConfirm').addEventListener('click', async () => {
    if (!pendingProduct || !currentUser) return;
    const valorIngresado = parseInt(qtyInput.value, 10);

    if (isNaN(valorIngresado)) {
        showToast('Ingresá un número válido.', 'error');
        return;
    }
    if (modoModalCantidad === 'sumar' && valorIngresado === 0) {
        showToast('Ingresá una cantidad válida (podés usar números negativos para restar).', 'error');
        return;
    }
    if (modoModalCantidad === 'editar' && valorIngresado < 0) {
        showToast('El stock no puede ser negativo.', 'error');
        return;
    }

    const producto = pendingProduct;
    const modo = modoModalCantidad;

    // Guardamos el stock original SOLO la primera vez que se modifica este
    // producto en el conteo actual (si ya estaba guardado, no lo pisamos).
    if (!stockOriginalPorCodigo.has(producto.codigoArt) && !productosNuevosEnEsteConteo.has(producto.codigoArt)) {
        stockOriginalPorCodigo.set(producto.codigoArt, producto.stock_unidad);
    }

    producto.stock_unidad = modo === 'editar' ? valorIngresado : producto.stock_unidad + valorIngresado;

    actualizarTablaUI(producto);
    hasChanges = true;
    productosModificados.set(producto.codigoArt, producto);
    actualizarBadgeConteo();
    renderTablaProductos();
    showToast(
        modo === 'editar'
            ? `${producto.articulo}: stock corregido a ${producto.stock_unidad}.`
            : `${producto.articulo}: nuevo stock ${producto.stock_unidad}.`,
        'success'
    );
    cerrarModalCantidad();

    const ok = await actualizarStockProducto(currentUser.uid, producto);
    if (!ok) {
        showToast(`No se pudo sincronizar el stock de "${producto.articulo}" con el catálogo.`, 'error');
    }

    await sincronizarItemInventario(producto);
});

qtyInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('qtyConfirm').click();
});

qtyModal.addEventListener('click', (e) => {
    if (e.target === qtyModal) cerrarModalCantidad();
});

// -------------------------------
// 8. Modal de producto nuevo (código no encontrado en el catálogo)
// -------------------------------
const newProductModal = document.getElementById('newProductModal');
let altaSinCodigo = false; // true cuando el modal se abrió desde "Por nombre" (sin código de barras)

function abrirModalProductoNuevo(codigo, descripcionPrellenada = '') {
    altaSinCodigo = !codigo;
    pendingScanCode = codigo || null;
    document.getElementById('npCodigo').textContent = codigo || 'Se asignará un código interno automáticamente';
    document.getElementById('npDescripcion').value = descripcionPrellenada;
    document.getElementById('npUnidades').value = 'unidad';
    document.getElementById('npStock').value = 1;
    newProductModal.classList.add('open');
    setTimeout(() => document.getElementById('npDescripcion').focus(), 50);
}

function cerrarModalProductoNuevo() {
    newProductModal.classList.remove('open');
    pendingScanCode = null;
    altaSinCodigo = false;
}

document.getElementById('npCancel').addEventListener('click', cerrarModalProductoNuevo);
newProductModal.addEventListener('click', (e) => {
    if (e.target === newProductModal) cerrarModalProductoNuevo();
});

// -------------------------------
// 8b. Modales de confirmación (reemplazan a los confirm()/prompt() nativos)
// -------------------------------

// mostrarConfirm({ titulo, mensaje, textoConfirmar, textoCancelar }) -> Promise<boolean>
// Reemplazo de window.confirm() con el diseño del sistema.
const confirmModal = document.getElementById('confirmModal');
const confirmModalTitle = document.getElementById('confirmModalTitle');
const confirmModalMessage = document.getElementById('confirmModalMessage');
const confirmModalBtnConfirm = document.getElementById('confirmModalConfirm');
const confirmModalBtnCancel = document.getElementById('confirmModalCancel');

function mostrarConfirm({ titulo = '¿Confirmás?', mensaje = '', textoConfirmar = 'Confirmar', textoCancelar = 'Cancelar' } = {}) {
    return new Promise((resolve) => {
        confirmModalTitle.textContent = titulo;
        confirmModalMessage.textContent = mensaje;
        confirmModalBtnConfirm.textContent = textoConfirmar;
        confirmModalBtnCancel.textContent = textoCancelar;
        confirmModal.classList.add('open');

        function limpiar() {
            confirmModal.classList.remove('open');
            confirmModalBtnConfirm.removeEventListener('click', onConfirmar);
            confirmModalBtnCancel.removeEventListener('click', onCancelar);
            confirmModal.removeEventListener('click', onOverlay);
            document.removeEventListener('keydown', onTecla);
        }
        function onConfirmar() { limpiar(); resolve(true); }
        function onCancelar() { limpiar(); resolve(false); }
        function onOverlay(e) { if (e.target === confirmModal) onCancelar(); }
        function onTecla(e) { if (e.key === 'Escape') onCancelar(); }

        confirmModalBtnConfirm.addEventListener('click', onConfirmar);
        confirmModalBtnCancel.addEventListener('click', onCancelar);
        confirmModal.addEventListener('click', onOverlay);
        document.addEventListener('keydown', onTecla);
    });
}

// mostrarConfirmPeligroso({ titulo, mensaje, palabraConfirmacion }) -> Promise<boolean>
// Reemplazo de window.prompt() para acciones destructivas: exige tipear una
// palabra exacta (ej. "BORRAR") para habilitar el botón de confirmar.
const dangerModal = document.getElementById('dangerModal');
const dangerModalTitle = document.getElementById('dangerModalTitle');
const dangerModalMessage = document.getElementById('dangerModalMessage');
const dangerModalInputLabel = document.getElementById('dangerModalInputLabel');
const dangerModalInput = document.getElementById('dangerModalInput');
const dangerModalBtnConfirm = document.getElementById('dangerModalConfirm');
const dangerModalBtnCancel = document.getElementById('dangerModalCancel');

function mostrarConfirmPeligroso({ titulo = 'Zona de peligro', mensaje = '', palabraConfirmacion = 'BORRAR', textoConfirmar = 'Confirmar' } = {}) {
    return new Promise((resolve) => {
        dangerModalTitle.textContent = titulo;
        dangerModalMessage.textContent = mensaje;
        dangerModalInputLabel.textContent = `Escribí ${palabraConfirmacion} para confirmar`;
        dangerModalInput.placeholder = palabraConfirmacion;
        dangerModalInput.value = '';
        dangerModalBtnConfirm.textContent = textoConfirmar;
        dangerModalBtnConfirm.disabled = true;
        dangerModal.classList.add('open');
        setTimeout(() => dangerModalInput.focus(), 50);

        function chequearInput() {
            dangerModalBtnConfirm.disabled = dangerModalInput.value !== palabraConfirmacion;
        }
        function limpiar() {
            dangerModal.classList.remove('open');
            dangerModalBtnConfirm.removeEventListener('click', onConfirmar);
            dangerModalBtnCancel.removeEventListener('click', onCancelar);
            dangerModal.removeEventListener('click', onOverlay);
            dangerModalInput.removeEventListener('input', chequearInput);
            dangerModalInput.removeEventListener('keydown', onTeclaInput);
            document.removeEventListener('keydown', onTecla);
        }
        function onConfirmar() {
            if (dangerModalInput.value !== palabraConfirmacion) return;
            limpiar();
            resolve(true);
        }
        function onCancelar() { limpiar(); resolve(false); }
        function onOverlay(e) { if (e.target === dangerModal) onCancelar(); }
        function onTecla(e) { if (e.key === 'Escape') onCancelar(); }
        function onTeclaInput(e) { if (e.key === 'Enter') onConfirmar(); }

        dangerModalBtnConfirm.addEventListener('click', onConfirmar);
        dangerModalBtnCancel.addEventListener('click', onCancelar);
        dangerModal.addEventListener('click', onOverlay);
        dangerModalInput.addEventListener('input', chequearInput);
        dangerModalInput.addEventListener('keydown', onTeclaInput);
        document.addEventListener('keydown', onTecla);
    });
}

document.getElementById('npConfirm').addEventListener('click', async () => {
    if (!currentUser) return;
    if (!altaSinCodigo && !pendingScanCode) return;

    const descripcion = document.getElementById('npDescripcion').value.trim();
    const unidades = document.getElementById('npUnidades').value.trim() || 'unidad';
    const stockInicial = parseInt(document.getElementById('npStock').value, 10);

    if (!descripcion) {
        showToast('Ingresá una descripción para el producto.', 'error');
        return;
    }
    if (isNaN(stockInicial)) {
        showToast('Ingresá un stock inicial válido.', 'error');
        return;
    }

    // Si viene de un escaneo usamos ese código; si es alta manual (sin código
    // de barras) generamos uno interno estable a partir de la descripción.
    const codigoArt = altaSinCodigo ? generarCodigoInternoUnico(descripcion) : pendingScanCode;

    const nuevoProducto = {
        registrado: '',
        hora: '',
        codigoArt,
        articulo: descripcion,
        unidades,
        stock_unidad: stockInicial
    };

    baseDeDatos.push(nuevoProducto);
    actualizarTablaUI(nuevoProducto);
    hasChanges = true;
    productosModificados.set(nuevoProducto.codigoArt, nuevoProducto);
    productosNuevosEnEsteConteo.add(nuevoProducto.codigoArt);
    actualizarBadgeConteo();
    renderTablaProductos();

    cerrarModalProductoNuevo();
    showToast(`${descripcion}: producto nuevo agregado con stock ${stockInicial}.`, 'success');

    try {
        await crearProducto(currentUser.uid, nuevoProducto);
        document.getElementById('catalogCount').textContent = baseDeDatos.length;
        document.getElementById('dbStatus').innerText = `Productos cargados · ${baseDeDatos.length} productos`;
        await sincronizarItemInventario(nuevoProducto);
    } catch (err) {
        console.error(err);
        showToast('El producto se guardó localmente pero no se pudo sincronizar con la base de datos.', 'error');
    }
});

document.getElementById('npDescripcion').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('npConfirm').click();
});

// -------------------------------
// 9. Actualizar el historial visual
// -------------------------------
function cssEscape(valor) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(valor);
    return String(valor).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function actualizarTablaUI(producto) {
    const tbody = document.getElementById('scannedTable');

    if (!hasChanges) {
        tbody.innerHTML = '';
    }

    // Si esta fila ya existía (ej. se está editando de nuevo), la sacamos para
    // volver a insertarla arriba y evitar filas duplicadas del mismo producto.
    const filaPrevia = tbody.querySelector(`tr[data-codigo="${cssEscape(producto.codigoArt)}"]`);
    if (filaPrevia) filaPrevia.remove();

    const tr = document.createElement('tr');
    tr.dataset.codigo = producto.codigoArt;
    const horaActual = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

    tr.innerHTML = `
        <td class="time-cell">${horaActual}</td>
        <td>${producto.articulo}<span class="product-code">${producto.codigoArt}</span></td>
        <td class="stock-cell">${producto.stock_unidad}</td>
        <td class="action-cell"><button type="button" class="row-delete-btn" data-accion="eliminar" title="Revertir / eliminar">✕</button></td>
    `;

    tbody.prepend(tr);
}

// -------------------------------
// 10. Exportar el .txt final
// -------------------------------
document.getElementById('downloadBtn').addEventListener('click', function () {
    if (productosModificados.size === 0) {
        showToast('Todavía no hay productos modificados para exportar.', 'error');
        return;
    }

    descargarTxt(generarContenidoTxt(productosModificadosACanonico()), 'avance_parcial.txt');
    showToast(`Avance descargado: ${productosModificados.size} producto(s) modificado(s).`, 'success');
});

// -------------------------------
// 11. Historial de conteos finalizados (.txt anteriores)
// -------------------------------
async function buscarHistorial() {
    if (!currentUser) return;

    const desdeVal = document.getElementById('histDesde').value;
    const hastaVal = document.getElementById('histHasta').value;
    const desde = desdeVal ? new Date(`${desdeVal}T00:00:00`) : null;
    const hasta = hastaVal ? new Date(`${hastaVal}T23:59:59`) : null;

    const vacio = document.getElementById('historialVacio');
    vacio.style.display = '';
    vacio.textContent = 'Buscando…';

    try {
        const resultados = await obtenerInventariosCerrados(currentUser.uid, desde, hasta);
        renderHistorial(resultados);
    } catch (err) {
        console.error(err);
        vacio.textContent = 'No se pudo traer el historial.';
        vacio.style.display = '';
    }
}

document.getElementById('histBuscarBtn').addEventListener('click', buscarHistorial);

function renderHistorial(resultados) {
    const lista = document.getElementById('historialLista');
    const vacio = document.getElementById('historialVacio');

    lista.querySelectorAll('.historial-item').forEach(el => el.remove());

    if (resultados.length === 0) {
        vacio.textContent = 'No hay conteos finalizados en ese rango de fechas.';
        vacio.style.display = '';
        return;
    }
    vacio.style.display = 'none';

    resultados.forEach(inv => {
        const items = Object.values(inv.items || {});
        const fechaCierre = (inv.fechaCierre && typeof inv.fechaCierre.toDate === 'function')
            ? inv.fechaCierre.toDate()
            : null;

        const wrapper = document.createElement('div');
        wrapper.className = 'historial-item';

        const filasProductos = items.map(it => `
            <tr>
                <td>${it.descripcion}<span class="product-code">${it.codigo}</span></td>
                <td class="stock-cell">${it.stock}</td>
            </tr>
        `).join('');

        wrapper.innerHTML = `
            <div class="historial-item-header">
                <div>
                    <div class="historial-item-nombre">${inv.nombre}</div>
                    <div class="historial-item-meta">${fechaCierre ? fechaCierre.toLocaleString('es-AR', { hour12: false }) : '—'} · ${items.length} producto(s)</div>
                </div>
                <div class="historial-item-acciones">
                    <button type="button" class="btn btn--ghost btn--sm hist-descargar">Descargar</button>
                </div>
            </div>
            <div class="historial-item-productos">
                <table>${filasProductos || '<tr><td colspan="2" class="empty-row">Sin productos</td></tr>'}</table>
            </div>
        `;

        wrapper.querySelector('.historial-item-header').addEventListener('click', function (e) {
            if (e.target.closest('.hist-descargar')) return;
            wrapper.classList.toggle('is-open');
        });

        wrapper.querySelector('.hist-descargar').addEventListener('click', function (e) {
            e.stopPropagation();
            const itemsCanonicos = items.map(it => ({
                registrado: '',
                hora: '',
                codigo: it.codigo,
                descripcion: it.descripcion,
                unidades: it.unidades,
                stock: it.stock
            }));
            descargarTxt(generarContenidoTxt(itemsCanonicos), `inventario_${inv.id}.txt`);
        });

        lista.appendChild(wrapper);
    });
}

function resetHistorial() {
    document.getElementById('histDesde').value = '';
    document.getElementById('histHasta').value = '';
    document.querySelectorAll('.historial-item').forEach(el => el.remove());
    const vacio = document.getElementById('historialVacio');
    vacio.style.display = '';
    vacio.textContent = 'Elegí un rango de fechas y tocá "Buscar conteos".';
}

// -------------------------------
// 12. Zona de peligro (testing): borrar catálogo e inventarios completos
// -------------------------------
document.getElementById('borrarTodoBtn').addEventListener('click', async function () {
    if (!currentUser) return;

    const confirmado = await mostrarConfirmPeligroso({
        titulo: 'Borrar todo',
        mensaje: `Esto borra TODOS los productos y TODOS los inventarios de ${currentUser.email}. No se puede deshacer.`,
        palabraConfirmacion: 'BORRAR'
    });
    if (!confirmado) {
        showToast('Cancelado. No se borró nada.', 'info');
        return;
    }

    const btn = this;
    btn.disabled = true;
    btn.textContent = 'Borrando…';

    try {
        const productosBorrados = await borrarCatalogoCompleto(currentUser.uid);
        // Esto también borra el documento "inventarios/{uid}_actual" — hay
        // que recrearlo después, si no la app se queda sin inventario activo.
        const inventariosBorrados = await borrarInventariosCompleto(currentUser.uid);

        hasChanges = false;
        stockOriginalPorCodigo.clear();
        productosNuevosEnEsteConteo.clear();
        resetHistorial();
        productsSearchInput.value = '';
        // baseDeDatos, productosModificados, la tabla de escaneos y el badge
        // se actualizan solos: los listeners de catálogo e inventario van a
        // recibir la limpieza (0 productos, 0 items) y redibujar todo.

        await asegurarInventarioActual(currentUser.uid);

        showToast(`Borrado completo: ${productosBorrados} producto(s) y ${inventariosBorrados} inventario(s). Ya podés subir un .txt nuevo.`, 'success');
    } catch (err) {
        console.error(err);
        showToast('No se pudo completar el borrado. Revisá la consola.', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Borrar catálogo e inventarios';
    }
});

// -------------------------------
// PWA: registro del Service Worker
// -------------------------------
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then((registration) => {
                // Si hay una versión nueva del SW esperando, avisamos para
                // que el usuario recargue y quede al día (evita que quede
                // atascado con una versión vieja del app shell cacheado).
                registration.addEventListener('updatefound', () => {
                    const nuevoWorker = registration.installing;
                    if (!nuevoWorker) return;
                    nuevoWorker.addEventListener('statechange', () => {
                        if (nuevoWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            showToast('Hay una actualización disponible. Cerrá y volvé a abrir la app para aplicarla.', 'info');
                        }
                    });
                });
            })
            .catch((err) => console.error('No se pudo registrar el Service Worker:', err));
    });
}
