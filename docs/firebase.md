# Configurar el respaldo en Firestore

Es opcional y gratis dentro del plan Spark para un uso personal. La app guarda una copia de tus notas en tu propio proyecto de Firebase; si el equipo falla, otra instalación de la app las recupera.

## Pasos (una sola vez)
1. Entra a <https://console.firebase.google.com> y crea un proyecto (puedes desactivar Google Analytics).
2. **Build → Firestore Database → Crear base de datos**. Elige una región cercana y el modo **producción**.
3. En la pestaña **Reglas**, deja todo denegado y publica:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} { allow read, write: if false; }
     }
   }
   ```
   La app usa una cuenta de servicio, que ignora estas reglas; así nadie más puede leer tus notas con la clave pública del proyecto.
4. **Configuración del proyecto (engranaje) → Cuentas de servicio → Generar nueva clave privada**. Se descarga un `.json`.
5. En la app, sección **Respaldo en Firestore → Elegir clave…** y selecciona ese archivo. La app comprueba que sirva y la copia a su carpeta de datos; después puedes borrar el original de Descargas.

## Cómo funciona
- Estructura en Firestore: `notes/{id}`, `profiles/{id}` y `meta/palette`. Los borrados se guardan como marcas (`deleted: true`, `deletedAt`) **conservando el contenido**, de modo que Firestore sirve de copia de la papelera: solo se recuperan desde la app. Al purgar (manual o a los 30 días) el contenido se vacía. Las marcas antiguas ya vacías no son recuperables.
- Cada cambio se sube en ~1 s. Sin internet los cambios se acumulan (también si cierras la app) y se suben al volver, con reintentos cada 5 s, 15 s, 1 min y 5 min.
- Los cambios hechos desde otro equipo llegan por escucha en tiempo real y se empujan a las extensiones.
- Conflictos: gana la edición más reciente (por fecha de modificación).
- **Recuperar en un equipo nuevo:** instala la app, elige la misma clave y las notas se descargan solas. Los perfiles de navegador se reasignan desde cada extensión.

## Seguridad
- La clave da acceso total al proyecto: no la compartas ni la subas a git (`.gitignore` ya excluye los nombres habituales). Si se filtra, bórrala en la consola de Firebase y genera otra.
- La clave se guarda como `firebase-key.json` en la carpeta de datos de la app. La ventana de la app nunca la lee: la lee el proceso principal.
- Si cambias a otro proyecto de Firebase, la app vuelve a subir todo al nuevo.

## Límites conocidos
- Probado con un doble en memoria y con el SDK simulado, no contra Firestore real.
- Un perfil renombrado en otro equipo no cambia el nombre local (solo se añaden los perfiles que faltan).
- El modo de compartir (`sharing`) de cada perfil también se copia a Firestore. Un perfil importado de otro equipo llega sin vincular (`dir` vacío) hasta que una extensión lo reclame con el mismo navegador y correo.
- Fecha de modificación según el reloj de cada equipo: si un reloj está muy desfasado, puede ganar una edición más vieja.
