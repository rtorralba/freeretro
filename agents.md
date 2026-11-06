# AGENTS.md — Guía de Arquitectura y Contexto para Agentes de IA

Este documento define la arquitectura, el modelo de datos, las reglas de sincronización P2P/CRDT y las convenciones de desarrollo de **FreeRetro** para cualquier agente de IA que modifique o amplíe el repositorio.

---

## 1. Propósito y Restricciones Arquitectónicas

**FreeRetro** es una aplicación web colaborativa para retrospectivas ágiles diseñada para alojarse directamente en **GitHub Pages**.

### Invariantes obligatorias:
1. **100% Estática (Zero-Backend / Zero-Build):**
   - No debe requerir servidor Node.js en producción ni bases de datos externas (Firebase, Supabase, etc.).
   - Debe funcionar sirviendo los archivos directamente desde la raíz del repositorio usando **ES Modules nativos** (`<script type="module">`).
   - Las dependencias externas deben cargarse vía CDN en `index.html` con degradación elegante si no están disponibles (`LZString` y `PeerJS`).
2. **Soporte para preparación previa (Asíncrona) + Colaboración en vivo (P2P):**
   - Los participantes pueden abrir un enlace antes de la reunión (`#room=...&init=...`), inicializar el tablero desde los metadatos de la URL y añadir tarjetas que se persisten en `localStorage`.
   - Al coincidir conectados en la sala (o al abrir un enlace con `&state=...`), todas las tarjetas se fusionan sin pérdida de datos.

---

## 2. Estructura del Proyecto

| Archivo | Responsabilidad |
| :--- | :--- |
| `index.html` | Estructura semántica de las dos vistas principales (`#dashboard-view` y `#board-view`), modales (`#share-modal`, `#profile-modal`) y carga de CDNs (`lz-string`, `peerjs`). |
| `css/styles.css` | Sistema de diseño con variables CSS para modo oscuro (`[data-theme="dark"]`) y claro (`[data-theme="light"]`), layout de columnas, tarjetas, efecto `blur` y componentes. |
| `js/storage.js` | Modelo de datos, plantillas (`TEMPLATES`), persistencia en `localStorage`, motor de fusión CRDT (`mergeSessions`), compresión URL (`encodePayloadToUrl` / `decodePayloadFromUrl`) y exportación a Markdown/JSON. |
| `js/sync.js` | Motor de sincronización P2P (`RetroSyncEngine`): elección determinista de Hub en PeerJS (WebRTC), malla híbrida entre pares, `BroadcastChannel` para pestañas locales y latidos (heartbeats). |
| `js/app.js` | Controlador principal (`FreeRetroApp`): enrutamiento por hash URL, renderizado del DOM, eventos delegados, Drag & Drop, temporizador sincronizado y gestión de fases. |

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
    endsAt: null, // Timestamp absoluto en ms cuando running === true
    updatedAt: 0
  },
  columns: [
    {
      id: "col-keep",
      title: "Seguir haciendo",
      subtitle: "...",
      color: "emerald", // 'emerald' | 'rose' | 'amber' | 'indigo' | 'sky'
      icon: "check-circle",
      isActionColumn: false,
      order: 0,
      updatedAt: 1730000000000,
      deleted: false
    }
  ],
  cards: {
    "card-xxxx": {
      id: "card-xxxx",
      columnId: "col-keep",
      text: "Contenido de la tarjeta",
      authorId: "user-xxxx",
      authorName: "Nombre",
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
1. **Nunca elimines físicamente tarjetas, columnas o comentarios de sus colecciones:**
   - Usa siempre borrado lógico (`item.deleted = true` y `item.updatedAt = Date.now()`). Si eliminas la clave de `session.cards`, al sincronizar con otro par que aún tenga esa tarjeta en memoria, la tarjeta "resucitará".
2. **Actualiza siempre `updatedAt`:**
   - Cualquier cambio en `session`, `session.settings`, `session.timer`, una columna, una tarjeta, un voto o un comentario **debe** actualizar su propiedad `updatedAt = Date.now()`.
   - Usa siempre `this.updateSession(mutatorFn)` en `FreeRetroApp` para garantizar que se actualice el timestamp, se persista en `localStorage`, se re-renderice la vista y se emita por P2P.
3. **Metadatos iniciales (`createSessionFromInitMetadata`):**
   - Cuando una sala se inicializa por primera vez a partir del parámetro `&init=` de la URL, sus `updatedAt` iniciales se fijan en `1` para que cualquier cambio hecho en vivo por el organizador o los pares tenga prioridad al fusionar con `mergeSessions()`.

---

## 4. Protocolo de Sincronización P2P (`js/sync.js`)

`RetroSyncEngine` combina dos canales de transporte:
1. **`BroadcastChannel` (`freeretro_bc_<roomId>`)**: Sincronización instantánea entre pestañas del mismo navegador (funciona incluso sin conexión a internet).
2. **WebRTC vía `PeerJS`**:
   - **Elección determinista de Hub**: El primer participante intenta registrar el ID `freeretro-v1-hub-<roomId>`.
   - Si tiene éxito (`this.isHub = true`), actúa como coordinador de la sala: acepta conexiones entrantes, reenvía actualizaciones (`STATE_UPDATE`) al resto de pares y comparte la lista de pares conocidos (`knownPeers`).
   - Si el ID ya está ocupado (`err.type === 'unavailable-id'`), el participante se registra con un ID aleatorio `freeretro-v1-peer-<roomId>-<rand>` y se conecta al Hub.
   - **Tolerancia a fallos (Auto-promoción)**: Si el Hub se desconecta, los pares restantes ejecutan `scheduleHubPromotion()` con un retardo aleatorio (*jitter* de 400–1200 ms) para que uno de ellos asuma el ID del Hub automáticamente sin caer la sala.

### Tipos de mensajes P2P:
- `SYNC_FULL`: Se envía al abrir una conexión nueva; incluye el perfil del usuario, el objeto `session` completo y `knownPeers`.
- `STATE_UPDATE`: Se envía cada vez que el usuario realiza un cambio local (`updateSession`).
- `PEER_ANNOUNCE`: Latido periódico (cada 8 s) para mantener actualizada la lista de avatares conectados.

---

## 5. Enrutamiento y Parámetros en Hash URL

La navegación se controla mediante `window.location.hash`:
- Sin hash (`#` o vacío): Muestra el Dashboard principal y el Historial de Sesiones Anteriores.
- `#room=<id>&init=<payload>`: Abre o inicializa la sala `<id>` usando la estructura de columnas y título comprimidos en `<payload>`.
- `#room=<id>&state=<payload>`: Fusiona mediante `mergeSessions()` una instantánea completa del tablero comprimida en `<payload>` y luego limpia el parámetro `state` de la barra de direcciones reemplazándolo por `init`.

---

## 6. Convenciones de Código y Seguridad

1. **Prevención de XSS**:
   - Todo texto introducido por el usuario o recibido por P2P (títulos, nombres de autor, textos de tarjetas, comentarios, colores, IDs) **debe** pasar por `this.escapeHtml()` antes de interpolarse en plantillas HTML (`innerHTML`).
2. **Estilos y Temas**:
   - No uses colores fijos de fondo o texto; utiliza las variables CSS definidas en `css/styles.css` (`--bg-surface`, `--bg-card`, `--text-main`, `--text-secondary`, etc.) para mantener compatibilidad entre los temas `dark` y `light`.
3. **Verificación rápida**:
   - Antes de dar por terminado cualquier cambio en JavaScript, verifica la sintaxis de los módulos con Node:
     ```powershell
     node --check js/storage.js; node --check js/sync.js; node --check js/app.js
     ```

