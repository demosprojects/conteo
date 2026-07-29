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
    addDoc,
    query,
    where,
    orderBy,
    limit,
    serverTimestamp,
    writeBatch
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

export async function obtenerInventarioAbierto(uid) {
    const q = query(
        collection(db, "inventarios"),
        where("usuario", "==", uid),
        where("estado", "==", "abierto"),
        orderBy("fecha", "desc"),
        limit(1)
    );
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const d = snap.docs[0];
    return { id: d.id, ...d.data() };
}

export async function crearInventario(uid) {
    const ahora = new Date();
    const nombre = `Conteo ${ahora.toLocaleDateString('es-AR')} ${ahora.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`;
    const ref = await addDoc(collection(db, "inventarios"), {
        usuario: uid,
        estado: "abierto",
        nombre,
        fecha: serverTimestamp(),
        fechaCierre: null,
        items: {}
    });
    return { id: ref.id, usuario: uid, estado: "abierto", nombre, items: {} };
}

export async function cerrarInventario(inventarioId) {
    const ref = doc(db, "inventarios", inventarioId);
    await updateDoc(ref, { estado: "cerrado", fechaCierre: serverTimestamp() });
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

// Actualiza (o crea) un item puntual dentro del mapa "items" del inventario actual.
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
