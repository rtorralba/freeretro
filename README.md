# FreeRetro 🔄 — Retrospectivas Colaborativas P2P para GitHub Pages

Aplicación web 100% estática (HTML, CSS y ES Modules) para realizar retrospectivas ágiles en equipo (**Seguir haciendo, Dejar de hacer, Empezar a hacer, Plan de Acción**, **4Ls**, **Mad/Sad/Glad**) sin necesidad de servidores propios ni bases de datos externas.

## ✨ Características principales

1. **Preparación anticipada (Pre-sesión)**:
   - Puedes inicializar una sesión días antes y compartir el enlace (`#room=...&init=...`).
   - La configuración del tablero (título, sprint, columnas personalizadas) viaja comprimida en la propia URL.
   - Cada participante puede entrar cuando quiera y añadir sus tarjetas por adelantado; quedan guardadas en su navegador (`localStorage`).
2. **Colaboración en tiempo real P2P (WebRTC + BroadcastChannel + CRDT)**:
   - Cuando los participantes abren el enlace durante la reunión, sus navegadores se conectan directamente entre sí mediante **PeerJS (WebRTC)**.
   - Un motor **CRDT (Last-Write-Wins Element Set)** fusiona automáticamente todas las tarjetas que cada persona preparó antes con las creadas en directo, sin perder ni sobrescribir nada.
3. **Enlaces de Instantánea (Snapshot URL) para aportación asíncrona o archivo**:
   - Desde **Compartir / Exportar**, puedes generar un enlace con **todo el estado comprimido en la URL** (`#room=...&state=...`).
   - Ideal si alguien dejó sus tarjetas antes pero no podrá conectarse a la videollamada, o para pegar el enlace final de la retrospectiva en Jira, Confluence, Notion o Slack.
4. **Historial de Sesiones Anteriores**:
   - Panel en la página principal con todas las sesiones pasadas guardadas en el navegador.
   - Permite buscarlas, reabrirlas, exportarlas a **Markdown** o **JSON**, e **importar automáticamente las acciones pendientes** de una retrospectiva anterior al crear la siguiente.
5. **Herramientas de facilitación**:
   - **Modo oculto (Blur)**: Las tarjetas de los demás aparecen borrosas mientras todos escriben hasta pulsar *"Revelar"*.
   - **Votación (+1)** con límite configurable de votos por participante y ordenación por más votadas.
   - **Temporizador sincronizado** entre todos los participantes conectados.
   - **Conversión rápida a Acción (`⚡`)** con asignación de responsable y casilla de completado.

---

## 🚀 Cómo alojarla en GitHub Pages

Al no requerir compilación ni backend, puedes subirla directamente:

1. Sube este repositorio a GitHub:
   ```bash
   git init
   git add .
   git commit -m "Initial commit: FreeRetro P2P"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/freeretro.git
   git push -u origin main
   ```
2. En tu repositorio de GitHub, ve a **Settings → Pages**.
3. En **Build and deployment**, selecciona **Deploy from a branch** → rama `main` y carpeta `/ (root)`. ¡Listo!

---

## 💻 Cómo probarla en local

Debido a que usa módulos ES (`<script type="module">`), ábrela con cualquier servidor estático local:

```bash
# Con Node.js (npx)
npx serve .

# O con Python
python -m http.server 8080
```

Luego abre `http://localhost:8080` en dos pestañas o navegadores distintos para ver la sincronización en tiempo real.

