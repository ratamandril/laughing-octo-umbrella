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
| `GET /profiles` | `{detected, registered}` (perfiles de Chrome/Edge del equipo) |
| `PUT /me/profile {browser, dir, name?}` | asigna esta extensión a un perfil detectado |
| `PATCH /profiles/:id {name}` | renombra un perfil |
| `GET /notes?since=<seq>` | notas con `seq` mayor; con `since>0` incluye borradas (`deleted:true`) |
| `PUT /notes/:id` | crea (201) o actualiza (200); si no se envía `profileId`, hereda el de la instancia |
| `DELETE /notes/:id` | borra (deja un tombstone) |
| `POST /notes/bulk {notes}` | importación; no pisa cambios más recientes → `{imported, skipped, invalid, seq}` |
| `GET/PUT /palette` | categorías de color (`{list}`) |
| `POST /open {noteId}` o `{url, profileId}` | abre la URL en el navegador y perfil correctos |

Errores: `{error: "<código>"}` con el estado HTTP correspondiente.

## Nota
`{id, title, description, url, host, scope: "url"|"domain", tags[], color, profileId, createdAt, updatedAt, deleted, seq}`.
`seq` lo asigna el servidor (contador global creciente). Gana la última escritura que llega.

## WebSocket `/ws` (sin polling)
1. Cliente → `{type:"hello", token, since?}` (en 5 s, o se cierra con 4401).
2. Servidor → `{type:"ready", instanceId, profile, profiles, seq}` y, si hay `since`, `{type:"catchup", seq, notes, palette|null}`.
3. Servidor → `{type:"notes", notes, seq}`, `{type:"palette", palette}`, `{type:"profiles", profiles}` cuando **otra** extensión cambia algo (nunca al autor).
4. Cliente → `{type:"ping"}` cada ~20 s → `{type:"pong"}`. Mantiene vivo el service worker de MV3.
5. Cierres: 4400 mensaje inválido, 4401 sin autorización, 4403 revocada u origen distinto, 4429 demasiadas conexiones.

Al reconectar, la extensión repite `hello` con el último `seq` visto y recibe lo que se perdió.
