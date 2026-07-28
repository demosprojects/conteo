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
    actualizarItemInventario
} from './firebase.js';

let baseDeDatos = [];
let hasChanges = false;
let pendingProduct = null;
let pendingScanCode = null;
let currentUser = null;
let inventarioActual = null; // { id, nombre, estado, items }

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
        await inicializarSesion(user.uid);
    } else {
        appRoot.classList.add('is-hidden');
        loginScreen.classList.remove('is-hidden');
        resetEstadoApp();
    }
});

async function inicializarSesion(uid) {
    try {
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
            mostrarCatalogoListo();
        } else {
            mostrarCargaInicial();
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
    inventarioActual = null;
    document.getElementById('scannedTable').innerHTML = '<tr><td colspan="3" class="empty-row">No hay modificaciones recientes</td></tr>';
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
    document.getElementById('startCameraBtn').disabled = false;
    document.getElementById('downloadBtn').disabled = false;
}

function deshabilitarEscaneo() {
    document.getElementById('scannerInput').disabled = true;
    document.getElementById('startCameraBtn').disabled = true;
    document.getElementById('downloadBtn').disabled = true;
}

document.getElementById('reemplazarCatalogoBtn').addEventListener('click', function () {
    document.getElementById('catalogUploadPanel').style.display = '';
});

document.getElementById('fileInput').addEventListener('change', function (e) {
    const file = e.target.files[0];
    if (!file || !currentUser) return;

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
        tr.innerHTML = `
            <td class="time-cell">—</td>
            <td>${item.descripcion}<span class="product-code">${item.codigo}</span></td>
            <td class="stock-cell">${item.stock}</td>
        `;
        document.getElementById('scannedTable').appendChild(tr);
    });
    hasChanges = true;
}

document.getElementById('nuevoInventarioBtn').addEventListener('click', async function () {
    if (!currentUser || !inventarioActual) return;
    if (!confirm('¿Iniciar un nuevo inventario? El actual quedará cerrado y guardado en el historial.')) return;

    try {
        await cerrarInventario(inventarioActual.id);
        inventarioActual = await crearInventario(currentUser.uid);
        renderInventarioBar();
        hasChanges = false;
        document.getElementById('scannedTable').innerHTML = '<tr><td colspan="3" class="empty-row">No hay modificaciones recientes</td></tr>';
        showToast(`Nuevo inventario iniciado: ${inventarioActual.nombre}`, 'success');
    } catch (err) {
        console.error(err);
        showToast('No se pudo iniciar un nuevo inventario.', 'error');
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
// 3. Tabs: Cámara / Manual
// -------------------------------
const tabCamera = document.getElementById('tabCamera');
const tabManual = document.getElementById('tabManual');
const panelCamera = document.getElementById('panelCamera');
const panelManual = document.getElementById('panelManual');

function activarTab(nombre) {
    const esCamera = nombre === 'camera';
    tabCamera.classList.toggle('is-active', esCamera);
    tabManual.classList.toggle('is-active', !esCamera);
    panelCamera.style.display = esCamera ? '' : 'none';
    panelManual.style.display = esCamera ? 'none' : '';

    if (!esCamera && isScanning) {
        detenerCamara();
    }
}

tabCamera.addEventListener('click', () => activarTab('camera'));
tabManual.addEventListener('click', () => {
    activarTab('manual');
    const input = document.getElementById('scannerInput');
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

function abrirModalCantidad(producto) {
    pendingProduct = producto;
    document.getElementById('qtyModalProductName').textContent = producto.articulo;
    document.getElementById('qtyModalProductCode').textContent = producto.codigoArt;
    document.getElementById('qtyModalCurrentStock').textContent = producto.stock_unidad;
    qtyInput.value = 1;
    qtyModal.classList.add('open');
    setTimeout(() => { qtyInput.focus(); qtyInput.select(); }, 50);
}

function cerrarModalCantidad() {
    qtyModal.classList.remove('open');
    pendingProduct = null;
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
    const cantidad = parseInt(qtyInput.value, 10);

    if (isNaN(cantidad) || cantidad === 0) {
        showToast('Ingresá una cantidad válida (podés usar números negativos para restar).', 'error');
        return;
    }

    const producto = pendingProduct;
    producto.stock_unidad += cantidad;

    actualizarTablaUI(producto);
    hasChanges = true;
    showToast(`${producto.articulo}: nuevo stock ${producto.stock_unidad}.`, 'success');
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
function actualizarTablaUI(producto) {
    const tbody = document.getElementById('scannedTable');

    if (!hasChanges) {
        tbody.innerHTML = '';
    }

    const tr = document.createElement('tr');
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
    let contenido = '';

    baseDeDatos.forEach(p => {
        contenido += `${p.registrado};${p.hora};${p.codigoArt};${p.articulo};${p.unidades};${p.stock_unidad};\n`;
    });

    const blob = new Blob([contenido], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'inventario_actualizado.txt';
    a.click();

    URL.revokeObjectURL(url);
    showToast('Archivo descargado correctamente.', 'success');
});