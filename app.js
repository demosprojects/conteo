// app.js - Lógica principal del Terminal de Escaneo (multi-cliente)
import {
    onAuthChange,
    loginUsuario,
    logoutUsuario,
    obtenerCatalogo,
    importarCatalogo,
    crearProducto,
    actualizarStockProducto,
    obtenerInventarioAbierto,
    crearInventario,
    cerrarInventario,
    actualizarItemInventario,
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

// Solo los productos que se modificaron en el conteo actual (para exportar el .txt)
const productosModificados = new Map();

// -------------------------------
// Caché local del catálogo (evita re-leer TODOS los productos de Firestore
// en cada carga de página; eso es lo que satura la cuota del plan gratis)
// -------------------------------
function claveCache(uid) {
    return `catalogo_cache_${uid}`;
}

function guardarCacheCatalogo(uid) {
    try {
        localStorage.setItem(claveCache(uid), JSON.stringify(baseDeDatos));
    } catch (e) {
        console.warn('No se pudo guardar el caché local del catálogo:', e);
    }
}

function leerCacheCatalogo(uid) {
    try {
        const raw = localStorage.getItem(claveCache(uid));
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        console.warn('No se pudo leer el caché local del catálogo:', e);
        return null;
    }
}

function borrarCacheCatalogo(uid) {
    try {
        localStorage.removeItem(claveCache(uid));
    } catch (e) { /* noop */ }
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
    try {
        // 1) Primero miramos si ya tenemos el catálogo cacheado en este dispositivo.
        //    Si existe, lo usamos directo y NO leemos Firestore (ahorra cientos/miles
        //    de lecturas cada vez que se abre o se recarga la página).
        const cache = leerCacheCatalogo(uid);
        if (cache && cache.length > 0) {
            baseDeDatos = cache;
            mostrarCatalogoListo();
        } else {
            // 2) Sin caché (primera vez en este dispositivo, o se limpió el caché):
            //    ahí sí bajamos todo el catálogo de Firestore, una sola vez, y lo guardamos.
            const catalogo = await obtenerCatalogo(uid);
            if (catalogo.length > 0) {
                baseDeDatos = catalogo.map(p => ({
                    registrado: '',
                    hora: '',
                    codigoArt: p.codigo,
                    articulo: p.descripcion,
                    unidades: p.unidades,
                    stock_unidad: p.stock || 0
                }));
                guardarCacheCatalogo(uid);
                mostrarCatalogoListo();
            } else {
                mostrarCargaInicial();
            }
        }
    } catch (err) {
        console.error(err);
        showToast('No se pudo cargar el catálogo desde Firebase.', 'error');
    }

    try {
        let inv = await obtenerInventarioAbierto(uid);
        if (!inv) {
            inv = await crearInventario(uid);
        }
        inventarioActual = inv;
        renderInventarioBar();
        cargarItemsExistentes(inv.items || {});
    } catch (err) {
        console.error(err);
        showToast('No se pudo abrir el inventario del día.', 'error');
    }
}

function resetEstadoApp() {
    baseDeDatos = [];
    hasChanges = false;
    productosModificados.clear();
    inventarioActual = null;
    document.getElementById('scannedTable').innerHTML = '<tr><td colspan="3" class="empty-row">No hay modificaciones recientes</td></tr>';
    resetHistorial();
    deshabilitarEscaneo();
    const dbStatus = document.getElementById('dbStatus');
    dbStatus.innerText = 'DB vacía · 0 productos';
    dbStatus.classList.remove('is-ready');
    if (isScanning) detenerCamara();
}

// -------------------------------
// 1. Catálogo (colección "productos" en Firestore)
// -------------------------------
function mostrarCatalogoListo() {
    const dbStatus = document.getElementById('dbStatus');
    dbStatus.innerText = `DB lista · ${baseDeDatos.length} productos`;
    dbStatus.classList.add('is-ready');

    document.getElementById('catalogUploadPanel').style.display = 'none';
    document.getElementById('catalogStatus').style.display = 'flex';
    document.getElementById('catalogCount').textContent = baseDeDatos.length;

    habilitarEscaneo();
}

function mostrarCargaInicial() {
    const dbStatus = document.getElementById('dbStatus');
    dbStatus.innerText = 'DB vacía · subí el catálogo inicial';
    dbStatus.classList.remove('is-ready');

    document.getElementById('catalogUploadPanel').style.display = '';
    document.getElementById('catalogStatus').style.display = 'none';

    deshabilitarEscaneo();
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

// Trae el catálogo fresco de Firestore (por ejemplo si otro dispositivo/local
// modificó stock) y renueva el caché local. Solo se usa cuando hace falta,
// no automáticamente en cada carga de página.
document.getElementById('sincronizarCatalogoBtn').addEventListener('click', async function () {
    if (!currentUser) return;
    showToast('Sincronizando catálogo con Firebase…', 'info');
    try {
        const catalogo = await obtenerCatalogo(currentUser.uid);
        baseDeDatos = catalogo.map(p => ({
            registrado: '',
            hora: '',
            codigoArt: p.codigo,
            articulo: p.descripcion,
            unidades: p.unidades,
            stock_unidad: p.stock || 0
        }));
        guardarCacheCatalogo(currentUser.uid);
        document.getElementById('catalogCount').textContent = baseDeDatos.length;
        showToast('Catálogo sincronizado.', 'success');
    } catch (err) {
        console.error(err);
        showToast('No se pudo sincronizar el catálogo.', 'error');
    }
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

    lines.forEach(line => {
        if (line.trim() === '') return;
        const cols = line.split(';');

        // La estructura es: Registrado;Hora;CodigoArt;Artículo;Unidades;Stock_Unidad;
        if (cols.length >= 6) {
            productos.push({
                registrado: cols[0],
                hora: cols[1],
                codigoArt: cols[2],
                articulo: cols[3],
                unidades: cols[4],
                stock_unidad: parseInt(cols[5]) || 0
            });
        }
    });

    if (productos.length === 0) {
        showToast('El archivo no tiene productos con el formato esperado.', 'error');
        return;
    }

    showToast('Subiendo catálogo a Firebase, puede tardar unos segundos…', 'info');

    try {
        await importarCatalogo(currentUser.uid, productos);
        baseDeDatos = productos;
        guardarCacheCatalogo(currentUser.uid);
        mostrarCatalogoListo();
        showToast(`Catálogo cargado: ${productos.length} productos.`, 'success');
    } catch (err) {
        console.error(err);
        showToast('No se pudo subir el catálogo a Firebase.', 'error');
    }
}

// -------------------------------
// 2. Inventario del día (colección "inventarios")
// -------------------------------
function renderInventarioBar() {
    document.getElementById('invName').textContent = inventarioActual.nombre;
    document.getElementById('invState').textContent = inventarioActual.estado;
}

function cargarItemsExistentes(items) {
    const entradas = Object.values(items || {});
    if (entradas.length === 0) return;

    entradas.forEach(item => {
        const tr = document.createElement('tr');
        tr.dataset.codigo = item.codigo;
        tr.innerHTML = `
            <td class="time-cell">—</td>
            <td>${item.descripcion}<span class="product-code">${item.codigo}</span></td>
            <td class="stock-cell">${item.stock}</td>
        `;
        document.getElementById('scannedTable').appendChild(tr);

        // Estos productos ya se habían modificado en este conteo (ej. se recargó
        // la página a mitad de jornada): los sumamos para que entren en el .txt.
        const producto = baseDeDatos.find(p => p.codigoArt === item.codigo);
        if (producto) productosModificados.set(item.codigo, producto);
    });
    hasChanges = true;
}

document.getElementById('scannedTable').addEventListener('click', function (e) {
    const fila = e.target.closest('tr[data-codigo]');
    if (!fila) return;

    const codigo = fila.dataset.codigo;
    const producto = baseDeDatos.find(p => p.codigoArt === codigo);

    if (!producto) {
        showToast('No se encontró este producto en el catálogo para editarlo.', 'error');
        return;
    }
    abrirModalCantidad(producto, 'editar');
});

document.getElementById('nuevoInventarioBtn').addEventListener('click', async function () {
    if (!currentUser || !inventarioActual) return;

    const cantidad = productosModificados.size;
    const mensaje = cantidad > 0
        ? `Se va a descargar el .txt con ${cantidad} producto(s) modificado(s) y se va a cerrar este conteo. ¿Confirmás?`
        : 'No modificaste ningún producto en este conteo, así que no hay nada para descargar. ¿Igual querés finalizarlo?';
    if (!confirm(mensaje)) return;

    try {
        if (cantidad > 0) {
            descargarTxt(generarContenidoTxt(productosModificadosACanonico()), 'inventario_actualizado.txt');
        }

        await cerrarInventario(inventarioActual.id);
        inventarioActual = await crearInventario(currentUser.uid);
        renderInventarioBar();
        hasChanges = false;
        productosModificados.clear();
        document.getElementById('scannedTable').innerHTML = '<tr><td colspan="3" class="empty-row">No hay modificaciones recientes</td></tr>';
        showToast(`Conteo finalizado. Nuevo inventario iniciado: ${inventarioActual.nombre}`, 'success');
    } catch (err) {
        console.error(err);
        showToast('No se pudo finalizar el conteo.', 'error');
    }
});

async function sincronizarItemInventario(producto) {
    if (!inventarioActual) return;
    const ok = await actualizarItemInventario(inventarioActual.id, producto.codigoArt, {
        codigo: producto.codigoArt,
        descripcion: producto.articulo,
        unidades: producto.unidades,
        stock: producto.stock_unidad
    });
    if (!ok) {
        showToast(`No se pudo sincronizar "${producto.articulo}" con el inventario en Firebase.`, 'error');
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
    const termino = normalizarTexto(this.value.trim());

    if (termino.length < 2) {
        buscarResultados.innerHTML = '';
        buscarResultados.classList.remove('has-items');
        return;
    }

    const coincidencias = baseDeDatos
        .filter(p => normalizarTexto(p.articulo).includes(termino))
        .slice(0, 25);

    renderResultadosBusqueda(coincidencias);
});

function renderResultadosBusqueda(productos) {
    buscarResultados.classList.add('has-items');

    if (productos.length === 0) {
        buscarResultados.innerHTML = '<div class="buscar-sin-resultados">No se encontró ningún producto con ese nombre.</div>';
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
    producto.stock_unidad = modo === 'editar' ? valorIngresado : producto.stock_unidad + valorIngresado;

    actualizarTablaUI(producto);
    hasChanges = true;
    productosModificados.set(producto.codigoArt, producto);
    guardarCacheCatalogo(currentUser.uid);
    showToast(
        modo === 'editar'
            ? `${producto.articulo}: stock corregido a ${producto.stock_unidad}.`
            : `${producto.articulo}: nuevo stock ${producto.stock_unidad}.`,
        'success'
    );
    cerrarModalCantidad();

    const ok = await actualizarStockProducto(currentUser.uid, producto.codigoArt, producto.stock_unidad);
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

function abrirModalProductoNuevo(codigo) {
    pendingScanCode = codigo;
    document.getElementById('npCodigo').textContent = codigo;
    document.getElementById('npDescripcion').value = '';
    document.getElementById('npUnidades').value = 'unidad';
    document.getElementById('npStock').value = 1;
    newProductModal.classList.add('open');
    setTimeout(() => document.getElementById('npDescripcion').focus(), 50);
}

function cerrarModalProductoNuevo() {
    newProductModal.classList.remove('open');
    pendingScanCode = null;
}

document.getElementById('npCancel').addEventListener('click', cerrarModalProductoNuevo);
newProductModal.addEventListener('click', (e) => {
    if (e.target === newProductModal) cerrarModalProductoNuevo();
});

document.getElementById('npConfirm').addEventListener('click', async () => {
    if (!pendingScanCode || !currentUser) return;

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

    const nuevoProducto = {
        registrado: '',
        hora: '',
        codigoArt: pendingScanCode,
        articulo: descripcion,
        unidades,
        stock_unidad: stockInicial
    };

    baseDeDatos.push(nuevoProducto);
    actualizarTablaUI(nuevoProducto);
    hasChanges = true;
    productosModificados.set(nuevoProducto.codigoArt, nuevoProducto);
    guardarCacheCatalogo(currentUser.uid);

    cerrarModalProductoNuevo();
    showToast(`${descripcion}: producto nuevo agregado con stock ${stockInicial}.`, 'success');

    try {
        await crearProducto(currentUser.uid, nuevoProducto);
        document.getElementById('catalogCount').textContent = baseDeDatos.length;
        await sincronizarItemInventario(nuevoProducto);
    } catch (err) {
        console.error(err);
        showToast('El producto se guardó localmente pero no se pudo sincronizar con Firebase.', 'error');
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
    const horaActual = new Date().toLocaleTimeString('en-US');

    tr.innerHTML = `
        <td class="time-cell">${horaActual}</td>
        <td>${producto.articulo}<span class="product-code">${producto.codigoArt}</span></td>
        <td class="stock-cell">${producto.stock_unidad}</td>
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
document.getElementById('histBuscarBtn').addEventListener('click', async function () {
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
        vacio.textContent = 'No se pudo traer el historial. Si es la primera vez, puede que falte crear un índice en Firestore: fijate en la consola del navegador, Firebase suele tirar un link para crearlo con un clic.';
        vacio.style.display = '';
    }
});

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
                    <div class="historial-item-meta">${fechaCierre ? fechaCierre.toLocaleString('es-AR') : '—'} · ${items.length} producto(s)</div>
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

    const confirmacion = prompt(`Esto borra TODOS los productos y TODOS los inventarios de ${currentUser.email}. No se puede deshacer.\n\nEscribí BORRAR para confirmar:`);
    if (confirmacion !== 'BORRAR') {
        showToast('Cancelado. No se borró nada.', 'info');
        return;
    }

    const btn = this;
    btn.disabled = true;
    btn.textContent = 'Borrando…';

    try {
        const productosBorrados = await borrarCatalogoCompleto(currentUser.uid);
        const inventariosBorrados = await borrarInventariosCompleto(currentUser.uid);

        borrarCacheCatalogo(currentUser.uid);
        baseDeDatos = [];
        hasChanges = false;
        productosModificados.clear();
        resetHistorial();
        document.getElementById('scannedTable').innerHTML = '<tr><td colspan="3" class="empty-row">No hay modificaciones recientes</td></tr>';

        inventarioActual = await crearInventario(currentUser.uid);
        renderInventarioBar();

        mostrarCargaInicial();

        showToast(`Borrado completo: ${productosBorrados} producto(s) y ${inventariosBorrados} inventario(s). Ya podés subir un .txt nuevo.`, 'success');
    } catch (err) {
        console.error(err);
        showToast('No se pudo completar el borrado. Revisá la consola.', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Borrar catálogo e inventarios';
    }
});
