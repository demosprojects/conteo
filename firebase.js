// firebase.js - Auth + Firestore multi-cliente
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
    getAuth,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    getFirestore,
    collection,
    doc,
    getDoc,
    getDocs,
    setDoc,
    updateDoc,
    deleteDoc,
    addDoc,
    query,
    where,
    orderBy,
    limit,
    serverTimestamp,
    deleteField,
    writeBatch,
    onSnapshot,
    runTransaction,
    enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBSv00ujiCNtJVmAtZrZpmS48VlXnFSW6Y",
  authDomain: "scanner-16e77.firebaseapp.com",
  projectId: "scanner-16e77",
  storageBucket: "scanner-16e77.firebasestorage.app",
  messagingSenderId: "988659136813",
  appId: "1:988659136813:web:61a4656ea1da5345e0bba4"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
const db = getFirestore(app);

// Cache local de Firestore (IndexedDB) para que, si el dispositivo se queda
// sin conexión un instante, los listeners de abajo sigan funcionando con la
// última foto conocida en vez de romperse. Si falla (ej. pestañas múltiples
// del mismo navegador, o navegador sin soporte), no es grave: simplemente no
// hay persistencia offline y todo sigue funcionando igual online.
try {
    await enableIndexedDbPersistence(db);
} catch (e) {
    console.warn('Persistencia offline no disponible:', e?.code || e);
}

// =========================================================
// Autenticación
// =========================================================

export function onAuthChange(callback) {
    return onAuthStateChanged(auth, callback);
}

export async function loginUsuario(email, password) {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    await asegurarUsuarioDoc(cred.user);
    return cred.user;
}

export function logoutUsuario() {
    return signOut(auth);
}

// Crea el documento de perfil la primera vez que un usuario inicia sesión.
// Las cuentas en sí se crean manualmente desde el panel de Firebase (Authentication).
async function asegurarUsuarioDoc(user) {
    const ref = doc(db, "usuarios", user.uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
        await setDoc(ref, {
            email: user.email,
            fechaAlta: serverTimestamp()
        });
    }
}

// =========================================================
// Utilidades
// =========================================================

// Los códigos de artículo pueden traer "/" (ej. talles "S/M"), ".", "*" o "[" "]",
// que Firestore no permite dentro de un ID de documento (rompe la ruta) ni dentro
// de un nombre de campo en un update con dot-notation (ej. "items.S/M").
// Los reemplazamos por "_" para que el ID/campo generado sea siempre válido.
function sanitizarCodigo(codigo) {
    const limpio = String(codigo ?? "").trim().replace(/[/.\[\]#$*]/g, "_");
    // Red de seguridad: si igual llega vacío (no debería, app.js ya asigna un
    // código interno estable), usamos un valor fijo en vez de uno aleatorio,
    // para que sea el mismo documento siempre y no se generen duplicados.
    return limpio === "" ? "SINCOD_VACIO" : limpio;
}

// =========================================================
// Catálogo de productos (colección "productos", 1 doc por producto por cliente)
// =========================================================

export async function obtenerCatalogo(uid) {
    const q = query(collection(db, "productos"), where("usuario", "==", uid));
    const snap = await getDocs(q);
    const productos = [];
    snap.forEach(d => productos.push(d.data()));
    return productos;
}

// Escucha el catálogo del usuario EN TIEMPO REAL. callback(productos) se
// llama con la lista completa apenas hay cualquier cambio (alta, baja,
// edición de stock) hecho desde CUALQUIER dispositivo — el propio o
// cualquier otro logueado con la misma cuenta. Reemplaza el viejo esquema de
// "getDocs una vez + cachear en localStorage + botón Sincronizar manual",
// que era la causa de que cada dispositivo mostrara una cantidad de
// productos distinta.
//
// Costo de lecturas: la primera vez que se conecta el listener paga 1
// lectura por producto (igual que antes con obtenerCatalogo). Después de
// eso, Firestore SOLO factura lecturas por los documentos que realmente
// cambiaron, no por todo el catálogo de nuevo — así que en uso normal
// (algunos productos cambiando de stock) consume bastante menos que hacer
// getDocs() repetidas veces.
//
// Devuelve una función "unsubscribe": hay que llamarla al cerrar sesión o
// cambiar de usuario, para no seguir escuchando (y facturando) de más.
export function escucharCatalogo(uid, callback, onError) {
    const q = query(collection(db, "productos"), where("usuario", "==", uid));
    return onSnapshot(q, (snap) => {
        const productos = [];
        snap.forEach(d => productos.push(d.data()));
        callback(productos);
    }, (err) => {
        console.error("❌ Error escuchando el catálogo:", err);
        if (onError) onError(err);
    });
}

// Carga inicial (o reemplazo) del catálogo desde el .txt. Se hace en lotes
// de 450 escrituras para respetar el límite de Firestore por batch (500).
export async function importarCatalogo(uid, productos) {
    const CHUNK = 450;
    for (let i = 0; i < productos.length; i += CHUNK) {
        const lote = productos.slice(i, i + CHUNK);
        const batch = writeBatch(db);
        lote.forEach(p => {
            const ref = doc(db, "productos", `${uid}_${sanitizarCodigo(p.codigoArt)}`);
            batch.set(ref, {
                usuario: uid,
                codigo: p.codigoArt,
                descripcion: p.articulo,
                unidades: p.unidades,
                stock: p.stock_unidad,
                actualizado: serverTimestamp()
            }, { merge: true });
        });
        await batch.commit();
    }
}

// Alta de un producto detectado al escanear que no existía en el catálogo.
export async function crearProducto(uid, producto) {
    const ref = doc(db, "productos", `${uid}_${sanitizarCodigo(producto.codigoArt)}`);
    await setDoc(ref, {
        usuario: uid,
        codigo: producto.codigoArt,
        descripcion: producto.articulo,
        unidades: producto.unidades,
        stock: producto.stock_unidad,
        actualizado: serverTimestamp()
    }, { merge: true });
}

// Borra un único producto del catálogo. Se usa cuando un producto se dio de
// alta por error durante un conteo (código escaneado mal, alta manual
// equivocada, etc.) y se elimina desde "Modificaciones" antes de sincronizar.
export async function eliminarProducto(uid, codigoArt) {
    const ref = doc(db, "productos", `${uid}_${sanitizarCodigo(codigoArt)}`);
    await deleteDoc(ref);
}

export async function actualizarStockProducto(uid, producto) {
    try {
        const ref = doc(db, "productos", `${uid}_${sanitizarCodigo(producto.codigoArt)}`);
        // setDoc con merge en vez de updateDoc: si el documento todavía no existe
        // bajo este ID (por ejemplo, un producto viejo cuyo código cambió al
        // asignarle uno interno), se crea con TODOS los datos en vez de fallar
        // o de crear un doc incompleto (sin descripción/unidades).
        await setDoc(ref, {
            usuario: uid,
            codigo: producto.codigoArt,
            descripcion: producto.articulo,
            unidades: producto.unidades,
            stock: producto.stock_unidad,
            actualizado: serverTimestamp()
        }, { merge: true });
        return true;
    } catch (e) {
        console.error("❌ Error actualizando stock del producto:", e);
        return false;
    }
}

// Borra TODOS los productos del catálogo de un usuario. Uso exclusivo de
// testing/reset (ver app.js: solo se puede disparar con ?reset=1 en la URL).
export async function borrarCatalogoCompleto(uid) {
    const q = query(collection(db, "productos"), where("usuario", "==", uid));
    const snap = await getDocs(q);
    const docs = snap.docs;
    const CHUNK = 450;
    for (let i = 0; i < docs.length; i += CHUNK) {
        const batch = writeBatch(db);
        docs.slice(i, i + CHUNK).forEach(d => batch.delete(d.ref));
        await batch.commit();
    }
    return docs.length;
}

// Borra TODOS los inventarios (abiertos y cerrados) de un usuario. Mismo uso
// exclusivo de testing/reset que borrarCatalogoCompleto.
export async function borrarInventariosCompleto(uid) {
    const q = query(collection(db, "inventarios"), where("usuario", "==", uid));
    const snap = await getDocs(q);
    const docs = snap.docs;
    const CHUNK = 450;
    for (let i = 0; i < docs.length; i += CHUNK) {
        const batch = writeBatch(db);
        docs.slice(i, i + CHUNK).forEach(d => batch.delete(d.ref));
        await batch.commit();
    }
    return docs.length;
}

// =========================================================
// Inventarios (colección "inventarios", 1 doc por conteo)
// =========================================================

// El inventario "abierto" de cada usuario vive SIEMPRE en el mismo ID de
// documento (uid + "_actual"), en vez de un ID random generado con addDoc.
// Esto es lo que garantiza que nunca puedan existir dos inventarios
// "abiertos" al mismo tiempo para el mismo usuario: no importa si dos
// dispositivos entran a la vez, ambos terminan apuntando al mismo documento,
// porque la ruta es la misma. Antes, con addDoc, dos dispositivos que
// entraban casi simultáneamente y no encontraban ninguno abierto podían
// crear dos documentos distintos, y cada uno se quedaba escaneando "para su
// lado" sin que el otro se enterara.
function refInventarioActual(uid) {
    return doc(db, "inventarios", `${uid}_actual`);
}

function nombreConteo() {
    const ahora = new Date();
    return `Conteo ${ahora.toLocaleDateString('es-AR')} ${ahora.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

// Se asegura de que el documento "actual" exista (primera vez que el usuario
// usa la app). Si dos dispositivos llaman a esto a la vez, el segundo setDoc
// simplemente pisa al primero con los mismos datos (mismo ID) — no genera
// duplicados como pasaba antes con addDoc.
export async function asegurarInventarioActual(uid) {
    const ref = refInventarioActual(uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
        await setDoc(ref, {
            usuario: uid,
            estado: "abierto",
            nombre: nombreConteo(),
            fecha: serverTimestamp(),
            fechaCierre: null,
            items: {}
        });
    }
}

// Escucha el inventario "actual" del usuario EN TIEMPO REAL. Cada escaneo
// hecho en cualquier dispositivo (celular, PC, etc.) actualiza este mismo
// documento, así que todos los que tengan la app abierta ven los mismos
// productos escaneados al instante, sin tocar ningún botón de sincronizar.
// callback(null) se llama si el documento todavía no existe (recién logueado
// por primera vez, antes de asegurarInventarioActual).
export function escucharInventarioActual(uid, callback, onError) {
    const ref = refInventarioActual(uid);
    return onSnapshot(ref, (snap) => {
        if (!snap.exists()) {
            callback(null);
            return;
        }
        callback({ id: snap.id, ...snap.data() });
    }, (err) => {
        console.error("❌ Error escuchando el inventario actual:", err);
        if (onError) onError(err);
    });
}

// Cierra el conteo actual y abre uno nuevo, todo en una única transacción
// atómica: o pasan las dos cosas, o no pasa ninguna. Esto evita que dos
// dispositivos finalizando "al mismo tiempo" pisen datos entre sí.
//
// 1) El contenido actual (items, nombre, fecha) se archiva como un
//    documento nuevo e independiente con estado "cerrado" — eso es lo que
//    después aparece en el Historial.
// 2) El documento "actual" (uid + "_actual") se resetea vacío para el
//    próximo conteo, EN EL MISMO ID de siempre, así todos los dispositivos
//    quedan mirando el nuevo conteo automáticamente por el listener de
//    arriba, sin que nadie tenga que recargar la página.
export async function cerrarInventario(uid) {
    const actualRef = refInventarioActual(uid);
    const historialRef = doc(collection(db, "inventarios"));

    await runTransaction(db, async (tx) => {
        const snap = await tx.get(actualRef);
        if (!snap.exists()) {
            throw new Error("No hay inventario abierto para cerrar.");
        }
        const datos = snap.data();

        tx.set(historialRef, {
            usuario: uid,
            estado: "cerrado",
            nombre: datos.nombre,
            fecha: datos.fecha || serverTimestamp(),
            fechaCierre: serverTimestamp(),
            items: datos.items || {}
        });

        tx.set(actualRef, {
            usuario: uid,
            estado: "abierto",
            nombre: nombreConteo(),
            fecha: serverTimestamp(),
            fechaCierre: null,
            items: {}
        });
    });
}

// Historial de conteos ya finalizados (cada uno equivale a un .txt descargado).
// desde/hasta son objetos Date de JS (opcionales) para acotar por fecha de cierre.
export async function obtenerInventariosCerrados(uid, desde = null, hasta = null) {
    const condiciones = [
        where("usuario", "==", uid),
        where("estado", "==", "cerrado")
    ];
    if (desde) condiciones.push(where("fechaCierre", ">=", desde));
    if (hasta) condiciones.push(where("fechaCierre", "<=", hasta));

    const q = query(
        collection(db, "inventarios"),
        ...condiciones,
        orderBy("fechaCierre", "desc"),
        limit(100)
    );
    const snap = await getDocs(q);
    const resultados = [];
    snap.forEach(d => resultados.push({ id: d.id, ...d.data() }));
    return resultados;
}

// Quita un item puntual del mapa "items" del inventario actual. Se usa al
// revertir una modificación desde "Modificaciones" (el producto vuelve a su
// stock original y deja de contar como modificado en este conteo).
export async function eliminarItemInventario(inventarioId, codigo) {
    try {
        const ref = doc(db, "inventarios", inventarioId);
        await updateDoc(ref, { [`items.${sanitizarCodigo(codigo)}`]: deleteField() });
        return true;
    } catch (e) {
        console.error("❌ Error quitando item del inventario:", e);
        return false;
    }
}
export async function actualizarItemInventario(inventarioId, codigo, item) {
    try {
        const ref = doc(db, "inventarios", inventarioId);
        await updateDoc(ref, { [`items.${sanitizarCodigo(codigo)}`]: item });
        return true;
    } catch (e) {
        console.error("❌ Error actualizando item del inventario:", e);
        return false;
    }
}
