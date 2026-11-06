# FreeRetro 🔄 — Retrospectivas Colaborativas P2P para GitHub Pages

Aplicación web 100% estática (HTML, CSS y ES Modules) para realizar retrospectivas ágiles en equipo (**Hechos, Seguir haciendo, Ideas, Empezar a hacer, Agradecimientos, Plan de Acción**, **4Ls**, **Mad/Sad/Glad**) sin necesidad de servidores propios ni bases de datos externas.

---

## ✨ Características principales

1. **Preparación anticipada (Pre-sesión)**:
   - Puedes inicializar una sesión días antes y compartir el enlace de invitación (`#room=...&init=...`).
   - La configuración del tablero (título, sprint, columnas personalizadas) viaja comprimida en la propia URL con `LZString`.
   - Cada participante puede entrar cuando quiera y añadir sus tarjetas por adelantado; se guardan en su propio navegador (`localStorage`).
2. **Colaboración en tiempo real Multicanal (WebSockets WSS + WebRTC + BroadcastChannel + CRDT)**:
   - Conexión instantánea entre diferentes navegadores y redes mediante canal pub/sub WSS y WebRTC nativo (sin sufrir límites `429`).
   - Un motor **CRDT (Last-Write-Wins Element Set)** fusiona automáticamente todas las tarjetas que cada persona preparó antes con las creadas en directo, sin perder ni sobrescribir nada.
3. **Música ambiental relajante integrada (CC0 / Dominio Público)**:
   - Sintetizador procedural en tiempo real mediante **Web Audio API** (`🎵 Zen`, `🥣 Cuencos`, `🌧️ Lluvia`).
   - Sin archivos externos ni licencias de audio; controlable por cualquier participante y con opción de silenciarla individualmente.
4. **Avatares divertidos**:
   - Selector visual de avatares (animales y criaturas divertidas) que se muestran en el perfil, en la barra de participantes conectados y en cada tarjeta del tablero.
5. **Enlaces de Instantánea (Snapshot URL) para aportación asíncrona o archivo**:
   - Desde **Compartir / Exportar**, puedes generar un enlace con **todas las tarjetas actuales comprimidas en la URL** (`#room=...&state=...`).
   - Ideal para guardar la sesión final en Jira, Confluence, Notion o Slack, o para que un participante que no puede asistir envíe sus notas.
6. **Historial de Sesiones Anteriores**:
   - Panel en la pantalla de inicio con todas las sesiones guardadas localmente.
   - Permite buscarlas, reabrirlas, exportarlas a **Markdown** o **JSON**, e **importar automáticamente las acciones pendientes** de una retro anterior al crear la siguiente.
7. **Herramientas de facilitación ágil**:
   - **Modo oculto (Blur)**: Las tarjetas de los compañeros aparecen borrosas mientras todos escriben hasta pulsar *"Revelar"*.
   - **Votación (+1)** con límite configurable de votos por participante y ordenación por más votadas.
   - **Temporizador sincronizado** con selector de minutos.
   - **Conversión rápida a Acción (`⚡`)** con asignación de responsable y casilla de verificación completada.

---

## 🚀 Cómo alojarla en GitHub Pages

Al no requerir compilación ni backend, puedes subirla directamente:

1. Sube este repositorio a GitHub:
   ```bash
   git add .
   git commit -m "feat: initial release of FreeRetro"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/freeretro.git
   git push -u origin main
   ```
2. En tu repositorio de GitHub, ve a **Settings → Pages**.
3. En **Build and deployment**, selecciona **Deploy from a branch** → rama `main` y carpeta `/ (root)`. ¡Listo!

---

## 💻 Cómo probarla en local

Debido a que usa módulos ES (`<script type="module">`), usa los scripts incluidos (requieren Python o Node.js):

```bash
./start.sh        # Linux / macOS
start.bat         # Windows
# Puerto opcional: ./start.sh 3000
```

O bien arranca manualmente cualquier servidor estático local:

```bash
# Con Node.js (npx)
npx serve .

# O con Python
python -m http.server 8080
```

Abre `http://localhost:8080` en dos navegadores o pestañas distintas para ver la sincronización en tiempo real.
