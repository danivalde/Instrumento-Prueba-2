// Puente entre el instrumento de jurados (página estática) y la base de datos
// Postgres compartida (Neon, conectada desde Vercel > Storage).
//
// Todo el sistema guarda "clave -> texto". Este archivo expone eso por HTTP:
//
//   GET    /api/kv?key=K            -> { key, value }            (404 si no existe)
//   GET    /api/kv?prefix=P         -> { items:[{key,value}...] } todas las claves que empiezan por P
//   POST   /api/kv   {key,value}    -> { ok:true }               crea o reemplaza
//   DELETE /api/kv?key=K            -> { ok:true }
//   DELETE /api/kv?prefix=P         -> { ok:true, borradas:N }   borra todas las que empiezan por P
//   GET    /api/kv?health=1         -> diagnóstico de la conexión (ábrelo en el navegador)
//
// Cada voto vive en su propia clave (voto:<jurado>:<postulación>), así que dos
// jurados guardando a la vez nunca se pisan entre sí.

import { neon } from '@neondatabase/serverless';

const NOMBRES_POSIBLES = ['DATABASE_URL', 'POSTGRES_URL', 'NEON_DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING'];

function conexionDesdeEntorno() {
  for (const nombre of NOMBRES_POSIBLES) {
    if (process.env[nombre]) return { nombre, valor: process.env[nombre] };
  }
  return null;
}

async function leerCuerpo(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
    if (Buffer.isBuffer(req.body)) { try { return JSON.parse(req.body.toString('utf8')); } catch (e) { return {}; } }
    return req.body;
  }
  const trozos = [];
  for await (const t of req) trozos.push(typeof t === 'string' ? Buffer.from(t) : t);
  try { return JSON.parse(Buffer.concat(trozos).toString('utf8') || '{}'); } catch (e) { return {}; }
}

// `sql` es una función de plantillas etiquetadas que devuelve la lista de filas
// (así funciona el driver de Neon). Recibirla como parámetro permite probar
// este mismo código contra un Postgres local sin tocar nada más.
export function crearManejador(sql, infoConexion) {
  let tablaLista = false;
  async function asegurarTabla() {
    if (tablaLista) return;
    await sql`CREATE TABLE IF NOT EXISTS jurados_kv (key TEXT PRIMARY KEY, value TEXT)`;
    tablaLista = true;
  }

  return async function manejador(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store, max-age=0'); // nunca servir votos viejos desde caché
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    const q = new URL(req.url, 'http://localhost').searchParams;

    if (!sql) {
      const visibles = Object.keys(process.env).filter(n => /DATABASE|POSTGRES|NEON|^PG/i.test(n)).sort();
      res.status(500).json({
        ok: false,
        error: 'No hay variable de conexión a la base de datos. En Vercel: proyecto > Storage > conecta una base Postgres (Neon) a ESTE proyecto y vuelve a desplegar.',
        variablesRelacionadasQueSiExisten: visibles,
      });
      return;
    }

    try {
      await asegurarTabla();

      if (req.method === 'GET') {
        if (q.get('health')) {
          const filas = await sql`SELECT count(*)::int AS n FROM jurados_kv`;
          const votos = await sql`SELECT count(*)::int AS n FROM jurados_kv WHERE starts_with(key, 'voto:')`;
          res.status(200).json({
            ok: true,
            baseDeDatos: 'conectada',
            variableUsada: infoConexion ? infoConexion.nombre : null,
            registrosTotales: filas[0].n,
            votosGuardados: votos[0].n,
          });
          return;
        }
        if (q.has('prefix')) {
          const prefijo = q.get('prefix') || '';
          const filas = await sql`SELECT key, value FROM jurados_kv WHERE starts_with(key, ${prefijo}) ORDER BY key LIMIT 20000`;
          res.status(200).json({ items: filas.map(f => ({ key: f.key, value: f.value })) });
          return;
        }
        const key = q.get('key');
        if (!key) { res.status(400).json({ error: 'Falta key o prefix' }); return; }
        const filas = await sql`SELECT value FROM jurados_kv WHERE key = ${key}`;
        if (filas.length === 0) { res.status(404).json({ error: 'not_found' }); return; }
        res.status(200).json({ key, value: filas[0].value });
        return;
      }

      if (req.method === 'POST') {
        const cuerpo = await leerCuerpo(req);
        const { key, value } = cuerpo || {};
        if (!key || typeof value !== 'string') { res.status(400).json({ error: 'Se requiere key y value (texto)' }); return; }
        await sql`
          INSERT INTO jurados_kv (key, value) VALUES (${key}, ${value})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `;
        res.status(200).json({ ok: true });
        return;
      }

      if (req.method === 'DELETE') {
        if (q.has('prefix')) {
          const prefijo = q.get('prefix') || '';
          if (prefijo.length < 3) { res.status(400).json({ error: 'Prefijo demasiado corto por seguridad' }); return; }
          const borradas = await sql`DELETE FROM jurados_kv WHERE starts_with(key, ${prefijo}) RETURNING key`;
          res.status(200).json({ ok: true, borradas: borradas.length });
          return;
        }
        const key = q.get('key');
        if (!key) { res.status(400).json({ error: 'Falta key o prefix' }); return; }
        await sql`DELETE FROM jurados_kv WHERE key = ${key}`;
        res.status(200).json({ ok: true });
        return;
      }

      res.status(405).json({ error: 'Método no permitido' });
    } catch (err) {
      console.error('Error en /api/kv:', err);
      res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
  };
}

const conexion = conexionDesdeEntorno();
export default crearManejador(conexion ? neon(conexion.valor) : null, conexion);
