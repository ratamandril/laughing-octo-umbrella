# Notas por URL

Extensión para **Edge y Chrome** que funciona como los favoritos de la barra de herramientas, pero para **notas**: cada nota queda ligada a una página (o a un sitio completo), con descripción, etiquetas y una categoría de color. Al abrir una página, la extensión te muestra las notas que tiene asociadas.

Sin dependencias ni paso de compilación: son archivos HTML, CSS y JavaScript con Manifest V3.

> **Modo con app (v1.4):** la carpeta `app/` es una app de escritorio que guarda las notas de todos tus perfiles de Chrome y Edge, las comparte en vivo entre ellos, abre cada nota en su navegador y perfil, y las respalda en Firestore. En **Ajustes → Conexión con la app** se empareja la extensión con un código (una vez por perfil; el código elige la cuenta). Sin la app, la extensión funciona sola como antes. Ver `app/README.md`, `docs/protocolo.md` y `docs/firebase.md`.

## Qué hace

- **Notas ligadas a una URL** exacta o a **todo el dominio**, a elección al crear la nota.
- **Título, descripción, etiquetas y color.** Los colores son categorías: cada una tiene nombre y una descripción de para qué la usas.
- **Popup** de tamaño fijo: el formulario "Nueva nota" queda fijo y solo la lista de notas tiene barra de desplazamiento. Si la página tiene notas, el ícono muestra cuántas son.
- **Menú «Opciones» en cada nota:** abrir la página, abrir en su perfil, copiar URL, editar, cambiar la vista (simple, normal o detallada) y eliminar.
- **Popup con dos secciones desplegables:** «Notas de esta página» (misma URL o dominio) y «Todas las notas», con un buscador para ambas y una línea de estado (app, nube).
- **Página completa** ("Todas mis notas") con vista, orden y agrupación propios, grupos por sitio desplegables (contraer/expandir todos), búsqueda de texto y filtros por etiqueta, categoría y alcance.
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

## Dónde se guardan las notas

Las notas se guardan en la **app de escritorio** (con respaldo opcional en Firestore). La extensión solo mantiene una copia local de lo que la app le entrega y una cola con los cambios aún sin enviar, así que puedes escribir una nota aunque la app esté cerrada y se enviará al reconectar. **Sin haber enlazado la extensión con la app no se pueden crear ni ver notas** (Ajustes → Conexión con la app).

Cada perfil guarda y edita solo sus notas; las de los demás se consultan en el popup (necesita la app abierta) y cada perfil decide si las comparte (solo lectura por defecto), las deja editar o las mantiene privadas.

Los ajustes de vista (tema, tamaño de letra, etc.) siguen usando `chrome.storage.sync`, es decir, la cuenta del navegador. Las notas de versiones anteriores, que vivían ahí, se conservan como copia y se importan una vez a la app al enlazar (el aviso aparece en Ajustes).

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
- Sin enlace con la app no se pueden crear ni ver notas.
- El menú contextual abre el popup con `chrome.action.openPopup()`; si el navegador no lo permite, se abre una ventana pequeña con el mismo formulario.

## Licencia

[MIT](LICENSE)
