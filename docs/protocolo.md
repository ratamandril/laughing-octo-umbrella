# Protocolo app ⇄ extensión (v1)

La app escucha en `http://127.0.0.1:47321` (puerto configurable con `NOTAS_PORT`). Todo es JSON.

## Reglas de seguridad
- `Host` debe ser `127.0.0.1:<puerto>`, `localhost:<puerto>` o `[::1]:<puerto>`.
- `Origin`, si existe, debe ser `chrome-extension://…` o `moz-extension://…`. Los `POST/PUT/PATCH/DELETE` y el WebSocket **exigen** Origin.
- `POST/PUT/PATCH` exigen `Content-Type: application/json`.
- Salvo `/health` y `/pair`, hay que enviar `Authorization: Bearer <token>`. El token queda atado al Origin con el que se emparejó.
- Límites: 1 MB por cuerpo (1 KB en `/pair`, 5 MB / 5000 notas en `/notes/bulk`), `/open` 20 por 10 s.

## Emparejar (una vez por perfil)
1. En la app, "Generar código" → `XXXX-XXXX` (caduca a 5 min, un solo uso, 5 intentos).
2. `POST /pair {code, browser: "chrome"|"edge"|…, label}` → `201 {token, instanceId, protocol}`.
   Errores: `410 no_active_code`, `401 invalid_code`, `429 locked`.
3. La extensión guarda el token en `chrome.storage.local`.

## Endpoints
| Método y ruta | Uso |
|---|---|
| `GET /health` | `{ok, app, protocol, version}` |
| `GET /me` | instancia, perfil asignado y `seq` actual |
| `DELETE /me` | la extensión se desvincula (revoca su propio token) |
| `GET /profiles` | `{detected, registered}` (perfiles de Chrome/Edge del equipo) |
| `PUT /me/profile {browser, dir, name?}` | asigna esta extensión a un perfil detectado |
| `PATCH /profiles/:id {name}` | renombra un perfil |
| `GET /notes?since=<seq>` | notas visibles con `seq` mayor; con `since>0` incluye las borradas **sin contenido** (`deleted:true`) |
| `PUT /notes/:id` | crea (201) o actualiza (200); si `profileId` falta, es `null` o vacío, hereda el de la nota o el de la instancia |
| `DELETE /notes/:id` | manda la nota a la papelera de la app (el contenido se conserva solo en la app y en Firestore) |
| `POST /notes/bulk {notes}` | importación; no pisa cambios más recientes → `{imported, skipped, invalid, rejected, seq}`. `rejected` lista los ids que esta extensión no puede tener (son de otro perfil): debe quitarlos de su caché |
| `GET/PUT /palette` | categorías de color (`{list}`) |
| `POST /open {noteId}` o `{url, profileId}` | abre la URL en el navegador y perfil correctos |

Errores: `{error: "<código>"}` con el estado HTTP correspondiente. Los endpoints de notas devuelven `409 profile_required` mientras la extensión no tenga perfil asignado, y `403 profile_not_allowed` si intenta leer o escribir notas de un perfil que no puede ver.

## Visibilidad y papelera
- Cada extensión ve por defecto **solo las notas de su propio perfil**. Desde la app se le conceden otros perfiles (`canSee`). Al cambiar el permiso llega `{type:"access"}` y la extensión hace una resincronización completa.
- Las notas borradas permanecen en la app (y en Firestore) con `deleted`, `deletedAt` y `purged`; solo se recuperan desde la pestaña **Papelera** de la app y se purgan a los 30 días. Las extensiones nunca reciben el contenido de una nota borrada: solo `{id, profileId, deleted:true, updatedAt, seq}`.
- Las marcas de borrado antiguas de Firestore que ya perdieron su contenido no se pueden recuperar.

## Nota
`{id, title, description, url, host, scope: "url"|"domain", tags[], color, profileId, createdAt, updatedAt, deleted, seq}`.
`seq` lo asigna el servidor (contador global creciente). Gana la última escritura que llega.

## WebSocket `/ws` (sin polling)
1. Cliente → `{type:"hello", token, since?}` (en 5 s, o se cierra con 4401).
2. Servidor → `{type:"ready", instanceId, profile, profiles, seq}` y, si hay `since`, `{type:"catchup", seq, notes, palette|null}`.
3. Servidor → `{type:"notes", notes, seq}` (filtradas por lo que ve cada socket), `{type:"palette", palette}`, `{type:"profiles", profiles}` cuando **otra** extensión cambia algo (nunca al autor); `{type:"access"}` cuando cambian sus permisos; `{type:"status", cloud}` con el estado de la nube (`state`, `pending`, `syncedSeq`).
4. Cliente → `{type:"ping"}` cada ~20 s → `{type:"pong"}`. Mantiene vivo el service worker de MV3.
5. Cierres: 4400 mensaje inválido, 4401 sin autorización, 4403 revocada u origen distinto, 4429 demasiadas conexiones.

Al reconectar, la extensión repite `hello` con el último `seq` visto y recibe lo que se perdió.
