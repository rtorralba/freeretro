# AGENTS.md — Guía de Arquitectura, Contexto y Reglas de Desarrollo para Agentes de IA

Este documento define la arquitectura, el modelo de datos, los motores de sincronización y audio, y las **reglas obligatorias de desarrollo** de **FreeRetro** para cualquier agente de IA o desarrollador que modifique o amplíe el repositorio.

---

## ⚠️ REGLA DE ORO DE DESARROLLO Y MANTENIMIENTO

> **TODA MODIFICACIÓN, NUEVA CARACTERÍSTICA O AJUSTE ARQUITECTÓNICO QUE REALICE LA IA DEBE QUEDAR REGISTRADO Y DOCUMENTADO EXPLÍCITAMENTE EN ESTE ARCHIVO (`AGENTS.md`) Y EN `README.md` (SI AFECTA AL USUARIO FINAL).**
>
> **Esto incluye cualquier cambio, por pequeño que sea (textos, nombres de columnas, iconos, estilos).** Además de describir el cambio en la sección correspondiente, hay que añadir una entrada al **Registro de Cambios** (sección 8) en la misma tarea, antes de darla por terminada.
>
> Ningún cambio funcional, de modelo de datos, de dependencias o de transporte P2P puede darse por finalizado sin actualizar la documentación correspondiente en este documento.

---

## 1. Propósito y Restricciones Arquitectónicas

**FreeRetro** es una aplicación web colaborativa para retrospectivas ágiles diseñada para alojarse directamente en **GitHub Pages** (o cualquier hosting de archivos estáticos).

### Invariantes obligatorias:
1. **100% Estática (Zero-Backend / Zero-Build):**
   - No requiere servidor Node.js en producción ni bases de datos propietarias externas (Firebase, Supabase, etc.).
   - Los archivos se sirven directamente desde la raíz del repositorio usando **ES Modules nativos** (`<script type="module">`).
   - Las librerías de CDN deben ser libres y cargarse con atributos `defer` en `index.html` (`lz-string`, `mqtt.js`).
2. **Soporte para preparación previa (Asíncrona) + Colaboración en vivo (P2P / Multi-Transport):**
   - Los participantes pueden abrir un enlace antes de la reunión (`#room=...&init=...`), inicializar el tablero desde los metadatos comprimidos de la URL y añadir tarjetas que se persisten en `localStorage`.
   - Al coincidir en la sala (o al abrir un enlace con instantánea `&state=...`), todas las tarjetas se fusionan sin pérdida de datos.

---

## 2. Estructura del Proyecto y Módulos

| Archivo | Responsabilidad |
| :--- | :--- |
| `index.html` | Estructura semántica de las vistas principales (`#dashboard-view` y `#board-view`), modales (`#share-modal`, `#profile-modal`), barra superior de estado fija y carga de CDNs. |
| `css/styles.css` | Sistema de diseño completo: soporte de tema claro/oscuro con `color-scheme`, layout multi-columna responsivo, estilo de tarjetas, animaciones de toasts y selector de avatares en cuadrícula. |
| `js/storage.js` | Modelo de datos, colecciones de plantillas (`TEMPLATES`), catálogo de avatares (`AVATARS`), persistencia en `localStorage`, motor de fusión CRDT (`mergeSessions`), compresión URL (`encodePayloadToUrl` / `decodePayloadFromUrl`) y exportación a Markdown/JSON. |
| `js/sync.js` | Motor de sincronización multicanal (`RetroSyncEngine`): canal instantáneo local (`BroadcastChannel`), pub/sub en tiempo real multi-red vía WebSockets MQTT (`broker.emqx.io` / `broker.hivemq.com`) y WebRTC nativo (`RTCPeerConnection` / `RTCDataChannel`). |
| `js/audio.js` | Sintetizador de música relajante procedural CC0 (`AmbientMusicEngine`) basado en Web Audio API (pads ambientales, cuencos y lluvia suave, sin archivos externos ni licencias). |
| `js/app.js` | Controlador principal (`FreeRetroApp`): enrutamiento por hash URL, renderizado reactivo del DOM, Drag & Drop de tarjetas, temporizador sincronizado, control de música y modal de avatar/perfil. |
| `start.sh` / `start.bat` | Scripts de arranque de un servidor web local estático (Linux/macOS y Windows). Usan `python3`/`py`/`python` (`http.server`) y, si no hay Python, `npx http-server`. Puerto por defecto 8080, configurable como primer argumento. |
| `agents.md` | Guía de arquitectura, modelos y protocolo de documentación continua para agentes de IA. |
| `README.md` | Guía para usuarios finales, características y despliegue en GitHub Pages. |

---

## 3. Modelo de Datos y Reglas CRDT (`js/storage.js`)

El estado de una sesión es un objeto JSON serializable almacenado bajo la clave `freeretro_session_<roomId>` en `localStorage`.

### Esquema de `Session`:
```js
{
  id: "retro-xxxx",
  title: "Retrospectiva de Sprint",
  sprint: "Sprint 42",
  templateId: "classic", // 'classic' | 'fourLs' | 'madSadGlad'
  coordinatorId: "user-xxxx",
  createdAt: 1730000000000,
  updatedAt: 1730000000000,
  settings: {
    cardsBlurred: true,
    phase: "write", // 'write' | 'group' | 'vote' | 'actions' | 'closed'
    maxVotes: 5,
    anonymousCards: false,
    updatedAt: 1730000000000
  },
  timer: {
    running: false,
    durationSec: 300,
    endsAt: null, // Timestamp en ms cuando running === true
    updatedAt: 0
  },
  music: {
    playing: false,
    style: "zen", // 'zen' | 'bowls' | 'rain'
    updatedAt: 0
  },
  columns: [
    {
      id: "col-facts",
      title: "Hechos",
      subtitle: "Datos, hitos o eventos objetivos del sprint",
      color: "sky", // 'sky' | 'emerald' | 'rose' | 'amber' | 'pink' | 'indigo'
      icon: "info",
      isActionColumn: false,
      order: 0,
      updatedAt: 1730000000000,
      deleted: false
    }
    // ... col-keep, col-stop, col-start, col-kudos, col-actions
  ],
  cards: {
    "card-xxxx": {
      id: "card-xxxx",
      columnId: "col-keep",
      text: "Contenido de la tarjeta",
      authorId: "user-xxxx",
      authorName: "Nombre",
      authorAvatar: "🦊",
      authorColor: "#6366f1",
      Assignee: "", // Usado en columnas donde isActionColumn === true
      done: false,  // Estado completado en acciones
      votes: {
        "user-xxxx": { count: 2, updatedAt: 1730000000000 }
      },
      comments: {
        "cm-xxxx": {
          id: "cm-xxxx",
          text: "Comentario",
          authorId: "user-xxxx",
          authorName: "Nombre",
          createdAt: 1730000000000,
          updatedAt: 1730000000000,
          deleted: false
        }
      },
      createdAt: 1730000000000,
      updatedAt: 1730000000000,
      deleted: false
    }
  }
}
```

### Reglas críticas al modificar el estado (CRDT LWW-Element-Set):
1. **Nunca elimines físicamente tarjetas, columnas o comentarios:**
   - Usa siempre borrado lógico (`item.deleted = true` y `item.updatedAt = Date.now()`). De lo contrario, la tarjeta volverá a aparecer al sincronizar con otro participante.
2. **Actualiza siempre `updatedAt`:**
   - Cualquier cambio en `session`, `session.settings`, `session.timer`, `session.music`, columnas, tarjetas, votos o comentarios **debe** actualizar su propiedad `updatedAt = Date.now()`.
   - Usa siempre `this.updateSession(mutatorFn)` en `FreeRetroApp`.
3. **Metadatos iniciales (`createSessionFromInitMetadata`):**
   - Cuando una sala se inicializa desde el enlace `&init=`, sus timestamps iniciales se fijan en `1` para que cualquier cambio posterior hecho en vivo tenga prioridad al fusionar con `mergeSessions()`.

---

## 4. Arquitectura de Sincronización en Tiempo Real (`js/sync.js`)

Para garantizar 100% de disponibilidad en GitHub Pages sin sufrir límites de peticiones (como los errores `429 Too Many Requests` de servidores de señalización públicos tipo PeerJS), el motor `RetroSyncEngine` implementa un sistema multicanal en capas:

1. **`BroadcastChannel` (`freeretro_bc_<roomId>`)**:
   - Sincronización inmediata (0 ms de latencia) entre diferentes pestañas del mismo navegador (incluso sin conexión a Internet).
2. **WebSockets MQTT Relay (`broker.emqx.io:8084` con fallback a `broker.hivemq.com:8884`)**:
   - Permite descubrimiento de sala, paso de mensajes de estado (`STATE_UPDATE`) y latidos (`PEER_ANNOUNCE`) entre navegadores y dispositivos en cualquier red sin necesidad de servidor propio ni registros.
3. **WebRTC Nativo (`RTCPeerConnection` + `RTCDataChannel`)**:
   - Utiliza el canal WSS como señalización ligera para abrir canales de datos P2P directos entre los pares conectados.

### Tipos de Mensajes:
- `SYNC_FULL`: Intercambio del estado completo de la sesión y perfil del usuario al conectarse.
- `STATE_UPDATE`: Emitido ante cualquier cambio local (añadir/mover tarjeta, votar, fase, timer, música).
- `PEER_ANNOUNCE`: Latido periódico para listar los avatares activos en la sala.

---

## 5. Música Ambiental CC0 (`js/audio.js`)

- Sintetizador procedural usando **Web Audio API**. No depende de descargas de audio, peticiones HTTP ni licencias externas.
- Modos disponibles:
  - `zen`: Acordes pentatónicos cálidos generativos con ondas sinusoidales/triangulares y filtro paso-bajo.
  - `bowls`: Armónicos brillantes inspirados en cuencos tibetanos.
  - `rain`: Ruido filtrado suave simulando lluvia relajante de fondo.
- Todos los participantes pueden activar o detener la música de la sala y silenciarla localmente en su propio dispositivo sin afectar a los demás.

---

## 6. Sistema de Avatares Divertidos

- Catálogo de 24 avatares (`AVATARS` en `js/storage.js`): animales, criaturas y símbolos divertidos.
- Cada usuario recibe uno al azar que puede cambiar en cualquier momento desde su perfil haciendo clic en su avatar en la barra superior.
- Se muestran en el botón de perfil, en la lista de conectados de la barra superior y en el encabezado de cada tarjeta creada.

---

## 7. Plantillas y Semántica de Columnas

- Las columnas **indican el tipo de tarjeta**. Las tarjetas **no fluyen de una columna a otra** como en un kanban (aunque se pueden arrastrar entre columnas para reclasificarlas) y no se "terminan" en las columnas normales.
- Solo la columna con `isActionColumn: true` (**Plan de Acción**) tiene el estado `done` (checkbox de completada) y asignado (`Assignee`). Desde cualquier tarjeta se puede crear un **accionable**, que se añade en esa columna.
- Plantilla `classic` (`TEMPLATES.classic` en `js/storage.js`), con estas columnas:

| Id | Título | Subtítulo | Color | Icono |
| :--- | :--- | :--- | :--- | :--- |
| `col-facts` | Hechos | Datos, hitos o eventos objetivos del sprint | sky | info |
| `col-keep` | Seguir haciendo | Lo que funciona bien y debemos mantener | emerald | check-circle |
| `col-stop` | **Ideas** | Propuestas y ocurrencias para mejorar | rose | lightbulb |
| `col-start` | Empezar a hacer | Prácticas o hábitos que queremos incorporar | amber | sparkles |
| `col-kudos` | Agradecimientos | Reconocimientos y gracias a compañeros | pink | heart |
| `col-actions` | Plan de Acción | Compromisos concretos para el próximo sprint | indigo | target |

- **Nota:** el id `col-stop` se conserva aunque el título sea ahora "Ideas" (antes "Dejar de hacer"), para no romper sesiones ya guardadas ni enlaces existentes. No lo renombres.

---

## 8. Registro de Cambios

Añade aquí una entrada por cada tarea (la más reciente arriba).

- **2026-11-06** — Añadidos `start.sh` y `start.bat` para arrancar un servidor local (puerto 8080 por defecto).
- **2026-11-06** — Plantilla `classic`: la columna "Dejar de hacer" pasa a ser **Ideas** (mismo id `col-stop`, nuevo subtítulo, icono `lightbulb`). Subtítulo de "Empezar a hacer" cambiado a "Prácticas o hábitos que queremos incorporar" para evitar solaparse con Ideas. Actualizados el nombre de la plantilla (`js/storage.js`, `index.html`) y `README.md`. Documentada la semántica de columnas (sección 7) y reforzada la regla de documentar todos los cambios.

---

## 9. Verificación de Código

Antes de finalizar cualquier tarea o commit, valida la sintaxis de todos los módulos JavaScript con Node:

```powershell
node --check js/storage.js; node --check js/sync.js; node --check js/audio.js; node --check js/app.js
```
