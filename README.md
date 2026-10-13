# Notas por URL

Extensión para **Edge y Chrome** que funciona como los favoritos de la barra de herramientas, pero para **notas**: cada nota queda ligada a una página (o a un sitio completo), con descripción, etiquetas y una categoría de color. Al abrir una página, la extensión te muestra las notas que tiene asociadas.

Sin dependencias ni paso de compilación: son archivos HTML, CSS y JavaScript con Manifest V3.

> **Modo con app (v1.4):** la carpeta `app/` es una app de escritorio que guarda las notas de todos tus perfiles de Chrome y Edge, las comparte en vivo entre ellos, abre cada nota en su navegador y perfil, y las respalda en Firestore. En **Ajustes → Conexión con la app** se empareja la extensión con un código (una vez por perfil). Sin la app, la extensión funciona sola como antes. Ver `app/README.md`, `docs/protocolo.md` y `docs/firebase.md`.

## Qué hace

- **Notas ligadas a una URL** exacta o a **todo el dominio**, a elección al crear la nota.
- **Título, descripción, etiquetas y color.** Los colores son categorías: cada una tiene nombre y una descripción de para qué la usas.
- **Popup** de tamaño fijo: el formulario "Nueva nota" queda fijo y solo la lista de notas tiene barra de desplazamiento. Si la página tiene notas, el ícono muestra cuántas son.
- **Tres vistas de nota:** simple (solo título), normal y detallada. En la vista simple, un clic sobre una nota la recorre por las tres, solo a ella.
- **Página completa** ("Ver todas") con todas las notas agrupadas por sitio, búsqueda de texto y filtros por etiqueta, categoría y alcance.
- **Menú contextual:** selecciona texto en una página, clic derecho y guárdalo como título o como descripción de una nota.
- **Atajo de teclado** para abrir el popup (`Alt+Shift+N` por defecto, configurable).
- **Exportar e importar JSON.** Al importar se combinan las notas: una nota existente solo se reemplaza si la importada es más reciente.
- **Etiquetas y color recordados:** el formulario puede conservar los de la última nota creada (opcional).
- **Tres temas:** *Claro cálido*, *Oscuro cálido* y *Oscuro*. Sin elegir uno, sigue el modo claro/oscuro del sistema.
- **Ajustes de vista** en el engranaje del popup: tamaño de letra, tamaño del popup y vista de las notas.

## Instalación (modo desarrollador)

1. Descarga o clona este repositorio.
2. Abre `edge://extensions` (Edge) o `chrome://extensions` (Chrome).
3. Activa **Modo de desarrollador**.
4. Pulsa **Cargar descomprimida** y elige la carpeta `extension/` (la que contiene `manifest.json`).
5. Tras cambiar el código, pulsa "Recargar" en la tarjeta de la extensión.

## Sincronización

Las notas se guardan con `chrome.storage.sync`: el navegador las sincroniza con la cuenta con la que iniciaste sesión (Google en Chrome, Microsoft en Edge). Sin conexión se guardan en el equipo y se suben al reconectarse.

Límites del navegador:

| Límite | Valor |
|---|---|
| Total | ~100 KB (102 400 bytes) |
| Por elemento | 8 KB (cada nota es un elemento) |
| Elementos | 512 |
| Escrituras | 1 800 por hora, 120 por minuto |

Esto da, en la práctica, unos cientos de notas. Chrome y Edge **no** se sincronizan entre sí. Como respaldo (o para pasar notas de un navegador a otro) usa **Exportar JSON** en la página completa.

### Sincronizar entre equipos con la versión descomprimida

La sincronización es por ID de extensión, y una extensión descomprimida recibe un ID distinto en cada equipo. Para fijarlo, añade una clave al `manifest.json`:

```bash
openssl genrsa 2048 > key.pem
openssl rsa -in key.pem -pubout -outform DER | openssl base64 -A
```

Copia la salida en un campo `"key"` del manifest y usa el mismo valor en todos los equipos. `key.pem` está en `.gitignore`: no lo subas. Esto no se ha probado entre dos equipos.

## Estructura

| Archivo | Función |
|---|---|
| `manifest.json` | Manifest V3, permisos (`storage`, `tabs`, `contextMenus`) y atajo |
| `storage.js` | Toda la capa de datos: notas, paleta, ajustes, exportar/importar |
| `ui.js` | Tarjetas de nota, selector de color y `openPage()` |
| `theme.js` | Aplica el tema antes de pintar (sin parpadeo) |
| `popup.html` / `popup.js` | Popup: lista de notas, formulario y engranaje |
| `notes.html` / `notes.js` | Página completa con búsqueda, filtros y exportar/importar |
| `options.html` / `options.js` | Ajustes: tema, categorías y atajo |
| `background.js` | Contador del ícono y menú contextual |
| `style.css` | Estilos y los tres temas (variables CSS) |

Todo el acceso a datos pasa por `storage.js`, así que cambiar el almacenamiento (por ejemplo, a una base de datos en la nube) se concentra en ese archivo.

## Limitaciones conocidas

- Solo funciona en páginas `http` y `https`.
- La URL se guarda sin el fragmento (`#...`) ni la barra final; la parte `?query` sí se conserva.
- Si se supera la cuota de sincronización, el popup muestra el error en lugar de guardar.
- El menú contextual abre el popup con `chrome.action.openPopup()`; si el navegador no lo permite, se abre una ventana pequeña con el mismo formulario.

## Licencia

[MIT](LICENSE)
