/**
 * FreeRetro - Main Application Controller
 */

import {
  TEMPLATES,
  generateId,
  getUserProfile,
  saveUserProfile,
  createEmptySession,
  mergeSessions,
  saveSession,
  loadSession,
  deleteSession,
  getSessionIndex,
  getPendingActionsFromSession,
  encodePayloadToUrl,
  decodePayloadFromUrl,
  createInitMetadata,
  createSessionFromInitMetadata,
  exportSessionToMarkdown,
  getCardVoteCount
} from './storage.js';

import { RetroSyncEngine } from './sync.js';
import { AmbientMusicEngine } from './audio.js';

class FreeRetroApp {
  constructor() {
    this.user = getUserProfile();
    this.currentSession = null;
    this.syncEngine = null;
    this.musicEngine = new AmbientMusicEngine();
    this.peers = [];
    this.syncStatus = { state: 'offline', label: 'Modo local', peerCount: 1 };
    this.timerInterval = null;
    this.sortByVotes = false;
    this.filterAuthorId = 'all';
    this.openCommentCards = new Set();
    this.editingCardId = null;
    this.draggedCardId = null;
    this.historySearchQuery = '';

    this.init();
  }

  init() {
    this.initTheme();
    this.bindGlobalEvents();
    this.ensureUserNamePromptIfNeeded();
    this.handleUrlRouting();
    window.addEventListener('hashchange', () => this.handleUrlRouting());
  }

  initTheme() {
    const savedTheme = localStorage.getItem('freeretro_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    this.updateThemeButton(savedTheme);
  }

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('freeretro_theme', next);
    this.updateThemeButton(next);
  }

  updateThemeButton(theme) {
    const btn = document.getElementById('btn-theme-toggle');
    if (btn) {
      btn.innerHTML = theme === 'dark'
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`
        : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
    }
  }

  ensureUserNamePromptIfNeeded() {
    if (!this.user.name) {
      this.user.name = 'Participante ' + this.user.id.slice(-3).toUpperCase();
      saveUserProfile(this.user);
    }
    this.renderUserBadge();
  }

  renderUserBadge() {
    const badge = document.getElementById('user-profile-btn');
    if (!badge) return;
    const initials = (this.user.name || 'U').slice(0, 2).toUpperCase();
    badge.innerHTML = `
      <span class="avatar-dot" style="background:${this.escapeHtml(this.user.color)}">${this.escapeHtml(initials)}</span>
      <span class="user-name-label">${this.escapeHtml(this.user.name)}</span>
    `;
  }

  /**
   * Reads URL hash parameters:
   * - `#room=retro-xyz&init=...` (Room link with board initialization metadata for pre-meeting entry)
   * - `#room=retro-xyz&state=...` (Snapshot / Async cards merge link)
   * - `#room=retro-xyz` (Direct room ID)
   * - Empty hash -> Home & Past Sessions Dashboard
   */
  handleUrlRouting() {
    const hash = window.location.hash.slice(1);
    if (!hash) {
      this.showDashboardView();
      return;
    }

    const params = new URLSearchParams(hash);
    const roomId = params.get('room');
    const initEncoded = params.get('init');
    const stateEncoded = params.get('state');

    if (!roomId) {
      this.showDashboardView();
      return;
    }

    let localSession = loadSession(roomId);

    // 1. If the URL includes full state snapshot (e.g. async contribution or archive link), merge it!
    if (stateEncoded) {
      const decodedState = decodePayloadFromUrl(stateEncoded);
      if (decodedState && decodedState.id) {
        localSession = localSession ? mergeSessions(localSession, decodedState) : decodedState;
        saveSession(localSession);
        this.showToast('Tarjetas y estado fusionados desde el enlace compartido');
        // Clean the heavy `state` param from URL while keeping `room` & `init`
        const initMeta = encodePayloadToUrl(createInitMetadata(localSession));
        history.replaceState(null, '', `#room=${encodeURIComponent(roomId)}&init=${initMeta}`);
      }
    }

    // 2. If the user opens the link BEFORE the meeting and doesn't have the session locally yet,
    // initialize it from the `init` URL metadata!
    if (!localSession && initEncoded) {
      const meta = decodePayloadFromUrl(initEncoded);
      if (meta && meta.id) {
        localSession = createSessionFromInitMetadata(meta);
        saveSession(localSession);
      }
    }

    // 3. Fallback if only `#room=xyz` was provided
    if (!localSession) {
      localSession = createEmptySession({
        id: roomId,
        title: `Retro ${roomId.replace(/^retro-/, '')}`,
        coordinatorId: this.user.id
      });
      saveSession(localSession);
    }

    this.openSessionBoard(localSession);
  }

  showDashboardView() {
    if (this.syncEngine) {
      this.syncEngine.destroy();
      this.syncEngine = null;
    }
    this.musicEngine.stop(true);
    clearInterval(this.timerInterval);
    this.currentSession = null;

    document.getElementById('dashboard-view').classList.remove('hidden');
    document.getElementById('board-view').classList.add('hidden');
    document.getElementById('navbar-room-status')?.classList.add('hidden');

    this.populatePreviousSessionSelect();
    this.renderSessionHistory();
  }

  openSessionBoard(session) {
    // Backfill coordinatorId for sessions created locally before coordinatorId was introduced
    if (!session.coordinatorId) {
      session.coordinatorId = this.user.id;
    }
    this.currentSession = session;
    saveSession(this.currentSession);

    document.getElementById('dashboard-view').classList.add('hidden');
    document.getElementById('board-view').classList.remove('hidden');
    document.getElementById('navbar-room-status')?.classList.remove('hidden');

    // Start P2P Sync Engine for this room
    if (this.syncEngine) {
      this.syncEngine.destroy();
    }

    this.syncEngine = new RetroSyncEngine({
      roomId: session.id,
      userProfile: this.user,
      getLocalSession: () => this.currentSession,
      onRemoteState: (remoteSession) => {
        this.currentSession = mergeSessions(this.currentSession, remoteSession);
        saveSession(this.currentSession);
        this.renderBoard();
      },
      onPeersChange: (peersList) => {
        this.peers = peersList;
        this.renderPeersBar();
      },
      onStatusChange: (statusObj) => {
        this.syncStatus = statusObj;
        this.renderSyncStatus();
        this.renderTimerDisplay();
        this.renderMusicControls();
      }
    });

    this.syncEngine.start();
    this.startTimerLoop();
    this.renderBoard();

    // Prompt for user's real name on first board entry if still generic
    if (this.user.name.startsWith('Participante ') && !sessionStorage.getItem('freeretro_name_prompted')) {
      sessionStorage.setItem('freeretro_name_prompted', '1');
      setTimeout(() => this.openProfileModal(), 300);
    }
  }

  /**
   * Mutates current session, updates timestamp, saves to localStorage,
   * re-renders UI, and broadcasts to all P2P peers.
   */
  updateSession(mutatorFn) {
    if (!this.currentSession) return;
    mutatorFn(this.currentSession);
    this.currentSession.updatedAt = Date.now();
    saveSession(this.currentSession);
    this.renderBoard();
    if (this.syncEngine) {
      this.syncEngine.broadcastState();
    }
  }

  // =========================================================================
  // DASHBOARD & PAST SESSIONS HISTORY
  // =========================================================================

  populatePreviousSessionSelect() {
    const select = document.getElementById('create-import-actions');
    if (!select) return;
    const index = getSessionIndex();
    select.innerHTML = `<option value="">No importar acciones anteriores</option>`;
    index.forEach(item => {
      if (item.actionCount > 0) {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.textContent = `${item.title}${item.sprint ? ` (${item.sprint})` : ''} — ${item.pendingActions} acciones pendientes`;
        select.appendChild(opt);
      }
    });
  }

  renderSessionHistory() {
    const container = document.getElementById('history-list');
    const countBadge = document.getElementById('history-count-badge');
    if (!container) return;

    const allSessions = getSessionIndex();
    if (countBadge) countBadge.textContent = allSessions.length;

    const query = this.historySearchQuery.toLowerCase().trim();
    const filtered = query
      ? allSessions.filter(s =>
          (s.title || '').toLowerCase().includes(query) ||
          (s.sprint || '').toLowerCase().includes(query) ||
          (s.id || '').toLowerCase().includes(query)
        )
      : allSessions;

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="empty-history">
          <div class="empty-icon">🗂️</div>
          <h3>${query ? 'No se encontraron sesiones con ese filtro' : 'Aún no tienes sesiones guardadas'}</h3>
          <p>Todas las retrospectivas que crees o en las que participes se guardarán automáticamente aquí para consultarlas cuando quieras.</p>
        </div>
      `;
      return;
    }

    const phaseNames = {
      write: '✍️ Escritura (Pre-sesión / En curso)',
      group: '🔍 Agrupación y Discusión',
      vote: '🗳️ Votación',
      actions: '🎯 Plan de Acción',
      closed: '✅ Finalizada'
    };

    container.innerHTML = filtered.map(item => {
      const dateStr = new Date(item.createdAt).toLocaleDateString('es-ES', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      const phaseBadge = phaseNames[item.phase] || 'En curso';
      const pendingBadge = item.pendingActions > 0
        ? `<span class="meta-pill warning">⚡ ${item.pendingActions} acciones pendientes</span>`
        : item.actionCount > 0
          ? `<span class="meta-pill success">✓ ${item.actionCount} acciones completadas</span>`
          : '';

      return `
        <div class="history-card" data-session-id="${this.escapeHtml(item.id)}">
          <div class="history-card-main">
            <div class="history-title-row">
              <h4>${this.escapeHtml(item.title)}</h4>
              ${item.sprint ? `<span class="sprint-tag">${this.escapeHtml(item.sprint)}</span>` : ''}
              <span class="phase-tag">${phaseBadge}</span>
            </div>
            <div class="history-meta-row">
              <span>📅 ${dateStr}</span>
              <span>💬 ${item.cardCount || 0} tarjetas</span>
              <span>👥 ${item.participantCount || 1} participantes</span>
              ${pendingBadge}
            </div>
          </div>
          <div class="history-card-actions">
            <button class="btn btn-primary btn-sm" data-action="open-history" data-id="${this.escapeHtml(item.id)}" title="Abrir tablero o añadir tarjetas">
              Abrir Sala
            </button>
            <button class="btn btn-secondary btn-sm" data-action="carry-over" data-id="${this.escapeHtml(item.id)}" title="Crear nueva retro importando las acciones pendientes de esta sesión">
              Continuar Acciones
            </button>
            <button class="btn btn-ghost btn-sm" data-action="export-md-history" data-id="${this.escapeHtml(item.id)}" title="Descargar resumen en Markdown">
              Markdown
            </button>
            <button class="btn btn-ghost btn-sm danger-text" data-action="delete-history" data-id="${this.escapeHtml(item.id)}" title="Eliminar del historial local">
              🗑️
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  // =========================================================================
  // BOARD RENDERING
  // =========================================================================

  renderBoard() {
    if (!this.currentSession) return;
    const s = this.currentSession;

    // Header Title & Sprint
    const titleEl = document.getElementById('board-title');
    const sprintEl = document.getElementById('board-sprint');
    if (titleEl) titleEl.textContent = s.title;
    if (sprintEl) {
      sprintEl.textContent = s.sprint || 'Sin sprint';
      sprintEl.classList.toggle('muted', !s.sprint);
    }

    // Phase selector buttons
    const currentPhase = s.settings?.phase || 'write';
    document.querySelectorAll('.phase-step').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.phase === currentPhase);
    });

    // Blur toggle button
    const isBlurred = Boolean(s.settings?.cardsBlurred);
    const blurBtn = document.getElementById('btn-toggle-blur');
    if (blurBtn) {
      blurBtn.classList.toggle('active-warning', isBlurred);
      blurBtn.innerHTML = isBlurred
        ? `<span class="icon">🙈</span> <span>Tarjetas Ocultas (Revelar)</span>`
        : `<span class="icon">👁️</span> <span>Tarjetas Visibles (Ocultar)</span>`;
    }

    // Pre-session / Blur info banner
    const bannerEl = document.getElementById('board-info-banner');
    if (bannerEl) {
      const remainingVotes = this.getRemainingVotes();
      if (isBlurred) {
        bannerEl.innerHTML = `
          <div class="banner-content blurred-mode">
            <span>🔒 <strong>Modo preparación / escritura privada activo:</strong> Puedes añadir tus tarjetas desde ahora. El resto de participantes las verán borrosas hasta que se pulse <em>"Revelar"</em> en la reunión.</span>
            <button class="btn btn-xs btn-light" id="banner-reveal-btn">Revelar todas ahora</button>
          </div>
        `;
      } else if (currentPhase === 'vote') {
        bannerEl.innerHTML = `
          <div class="banner-content vote-mode">
            <span>🗳️ <strong>Fase de Votación:</strong> Te quedan <strong>${remainingVotes}</strong> de ${s.settings?.maxVotes || 5} votos disponibles. Vota las tarjetas más importantes para priorizar.</span>
            <button class="btn btn-xs btn-light" id="banner-sort-votes-btn">${this.sortByVotes ? 'Ordenar por creación' : 'Ordenar por más votadas'}</button>
          </div>
        `;
      } else {
        bannerEl.innerHTML = '';
      }
    }

    // Sort by votes button state
    const sortBtn = document.getElementById('btn-sort-votes');
    if (sortBtn) {
      sortBtn.classList.toggle('active', this.sortByVotes);
    }

    // Render Timer & Music display
    this.renderTimerDisplay();
    this.renderMusicControls();

    // Render Columns & Cards
    const columnsContainer = document.getElementById('board-columns');
    if (!columnsContainer) return;

    const activeColumns = (s.columns || [])
      .filter(c => !c.deleted)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const allCards = Object.values(s.cards || {}).filter(c => !c.deleted);

    columnsContainer.innerHTML = activeColumns.map(col => {
      let colCards = allCards.filter(c => c.columnId === col.id);
      if (this.filterAuthorId !== 'all') {
        colCards = colCards.filter(c => c.authorId === this.filterAuthorId);
      }
      if (this.sortByVotes) {
        colCards.sort((a, b) => getCardVoteCount(b) - getCardVoteCount(a) || a.createdAt - b.createdAt);
      } else {
        colCards.sort((a, b) => a.createdAt - b.createdAt);
      }

      return `
        <section class="retro-column color-${this.escapeHtml(col.color || 'indigo')}" data-column-id="${this.escapeHtml(col.id)}">
          <header class="column-header">
            <div class="column-title-group">
              <span class="column-color-indicator"></span>
              <div>
                <h3 class="column-title" data-action="edit-column-title" data-col-id="${this.escapeHtml(col.id)}" title="Haz clic para renombrar columna">
                  ${this.escapeHtml(col.title)}
                </h3>
                ${col.subtitle ? `<p class="column-subtitle">${this.escapeHtml(col.subtitle)}</p>` : ''}
              </div>
            </div>
            <span class="column-count">${colCards.length}</span>
          </header>

          <form class="add-card-form" data-col-id="${this.escapeHtml(col.id)}">
            <textarea
              name="cardText"
              rows="2"
              placeholder="${col.isActionColumn ? 'Añadir nueva acción concreta... (Enter para guardar)' : `Añadir tarjeta en "${this.escapeHtml(col.title)}"... (Enter)`}"
              required
            ></textarea>
            <div class="add-card-footer">
              ${col.isActionColumn ? `
                <input type="text" name="assignee" class="assignee-input" placeholder="Responsable (opcional)" />
              ` : `<span class="hint-text">Enter para añadir · Shift+Enter nueva línea</span>`}
              <button type="submit" class="btn btn-primary btn-xs">+ Añadir</button>
            </div>
          </form>

          <div class="cards-list" data-drop-col="${this.escapeHtml(col.id)}">
            ${colCards.length === 0
              ? `<div class="empty-column-placeholder">Arrastra o escribe una tarjeta aquí</div>`
              : colCards.map(card => this.renderCardHtml(card, col, isBlurred)).join('')
            }
          </div>
        </section>
      `;
    }).join('');
  }

  renderCardHtml(card, col, isBlurred) {
    const isOwnCard = card.authorId === this.user.id;
    const shouldBlur = isBlurred && !isOwnCard;
    const totalVotes = getCardVoteCount(card);
    const myVotes = Number(card.votes?.[this.user.id]?.count || 0);
    const comments = Object.values(card.comments || {})
      .filter(cm => !cm.deleted)
      .sort((a, b) => a.createdAt - b.createdAt);
    const isCommentsOpen = this.openCommentCards.has(card.id);
    const isEditing = this.editingCardId === card.id;

    if (shouldBlur) {
      return `
        <article class="retro-card is-blurred" data-card-id="${this.escapeHtml(card.id)}">
          <div class="blurred-body">
            <p class="blurred-text">Esta tarjeta está oculta mientras todos terminan de escribir sus ideas.</p>
            <span class="blurred-badge">🙈 Tarjeta de ${this.escapeHtml(card.authorName || 'Compañero')}</span>
          </div>
        </article>
      `;
    }

    return `
      <article
        class="retro-card ${col.isActionColumn ? 'action-card' : ''} ${card.done ? 'card-done' : ''}"
        draggable="${!isEditing}"
        data-card-id="${this.escapeHtml(card.id)}"
      >
        <div class="card-top-bar">
          <div class="card-author">
            <span class="author-dot" style="background:${this.escapeHtml(card.authorColor || '#6366f1')}"></span>
            <span>${this.escapeHtml(card.authorName || 'Anónimo')}</span>
            ${isBlurred && isOwnCard ? `<span class="own-private-tag" title="Solo tú puedes leer tu tarjeta hasta que se revelen">🔒 Solo visible para ti</span>` : ''}
          </div>
          <div class="card-quick-tools">
            ${!col.isActionColumn ? `
              <button class="icon-btn" data-action="convert-to-action" data-card-id="${this.escapeHtml(card.id)}" title="Crear acción a partir de esta tarjeta">⚡</button>
            ` : ''}
            <button class="icon-btn" data-action="edit-card" data-card-id="${this.escapeHtml(card.id)}" title="Editar tarjeta">✏️</button>
            <button class="icon-btn danger-hover" data-action="delete-card" data-card-id="${this.escapeHtml(card.id)}" title="Eliminar tarjeta">✕</button>
          </div>
        </div>

        ${isEditing ? `
          <form class="edit-card-form" data-card-id="${this.escapeHtml(card.id)}">
            <textarea name="editText" rows="3" required>${this.escapeHtml(card.text)}</textarea>
            ${col.isActionColumn ? `
              <input type="text" name="editAssignee" class="assignee-input" placeholder="Responsable" value="${this.escapeHtml(card.Assignee || '')}" />
            ` : ''}
            <div class="edit-actions">
              <button type="button" class="btn btn-ghost btn-xs" data-action="cancel-edit">Cancelar</button>
              <button type="submit" class="btn btn-primary btn-xs">Guardar</button>
            </div>
          </form>
        ` : `
          <div class="card-content">
            ${col.isActionColumn ? `
              <label class="action-checkbox-row">
                <input type="checkbox" data-action="toggle-action-done" data-card-id="${this.escapeHtml(card.id)}" ${card.done ? 'checked' : ''} />
                <span class="card-text">${this.formatCardText(card.text)}</span>
              </label>
              ${card.Assignee ? `<div class="assignee-badge">👤 Responsable: <strong>${this.escapeHtml(card.Assignee)}</strong></div>` : ''}
            ` : `
              <p class="card-text">${this.formatCardText(card.text)}</p>
            `}
          </div>
        `}

        <div class="card-Bottom-bar">
          <div class="vote-controls">
            <button
              class="vote-btn ${myVotes > 0 ? 'voted' : ''}"
              data-action="vote-up"
              data-card-id="${this.escapeHtml(card.id)}"
              title="Votar esta tarjeta (+1)"
            >
              👍 <span>${totalVotes}</span>
              ${myVotes > 0 ? `<small class="my-vote-pill">(${myVotes} tuyo${myVotes > 1 ? 's' : ''})</small>` : ''}
            </button>
            ${myVotes > 0 ? `
              <button class="unvote-btn" data-action="vote-down" data-card-id="${this.escapeHtml(card.id)}" title="Quitar mi voto">−</button>
            ` : ''}
          </div>

          <button class="comment-toggle-btn ${comments.length > 0 ? 'has-comments' : ''}" data-action="toggle-comments" data-card-id="${this.escapeHtml(card.id)}">
            💬 ${comments.length}
          </button>
        </div>

        ${isCommentsOpen ? `
          <div class="card-comments-section">
            <div class="comments-list">
              ${comments.map(cm => `
                <div class="comment-item">
                  <strong>${this.escapeHtml(cm.authorName)}:</strong>
                  <span>${this.escapeHtml(cm.text)}</span>
                </div>
              `).join('')}
            </div>
            <form class="add-comment-form" data-card-id="${this.escapeHtml(card.id)}">
              <input type="text" name="commentText" placeholder="Añadir comentario..." required />
              <button type="submit" class="btn btn-primary btn-xs">Enviar</button>
            </form>
          </div>
        ` : ''}
      </article>
    `;
  }

  getRemainingVotes() {
    if (!this.currentSession) return 0;
    const maxVotes = Number(this.currentSession.settings?.maxVotes || 5);
    const activeCards = Object.values(this.currentSession.cards || {}).filter(c => !c.deleted);
    const usedVotes = activeCards.reduce((sum, c) => sum + Number(c.votes?.[this.user.id]?.count || 0), 0);
    return Math.max(0, maxVotes - usedVotes);
  }

  renderPeersBar() {
    const container = document.getElementById('peers-avatars');
    if (!container) return;
    const list = this.peers.length > 0 ? this.peers : [{
      id: this.user.id,
      name: this.user.name,
      color: this.user.color,
      isSelf: true
    }];

    container.innerHTML = list.map(p => {
      const initials = (p.name || 'U').slice(0, 2).toUpperCase();
      return `
        <span
          class="peer-avatar ${p.isSelf ? 'is-self' : ''}"
          style="background:${this.escapeHtml(p.color || '#6366f1')}"
          title="${this.escapeHtml(p.name)}${p.isSelf ? ' (Tú)' : ' (Conectado en tiempo real)'}"
        >${this.escapeHtml(initials)}</span>
      `;
    }).join('');
  }

  renderSyncStatus() {
    const el = document.getElementById('sync-status-pill');
    if (!el) return;
    el.className = `sync-pill status-${this.syncStatus.state}`;
    el.title = this.syncStatus.label || 'Sala P2P';
  }

  // =========================================================================
  // SYNCHRONIZED COUNTDOWN TIMER
  // =========================================================================

  startTimerLoop() {
    clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      this.renderTimerDisplay();
    }, 1000);
  }

  renderTimerDisplay() {
    const display = document.getElementById('timer-display');
    const toggleBtn = document.getElementById('btn-timer-toggle');
    if (!display || !this.currentSession) return;

    const timer = this.currentSession.timer || { running: false, durationSec: 300, endsAt: null };
    let remainingSec = timer.durationSec || 300;

    if (timer.running && timer.endsAt) {
      remainingSec = Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 1000));
      if (remainingSec === 0) {
        this.updateSession(s => {
          s.timer.running = false;
          s.timer.endsAt = null;
          s.timer.updatedAt = Date.now();
        });
        this.showToast('⏰ ¡Tiempo terminado!');
      }
    }

    const mins = String(Math.floor(remainingSec / 60)).padStart(2, '0');
    const secs = String(remainingSec % 60).padStart(2, '0');
    display.textContent = `${mins}:${secs}`;
    display.classList.toggle('timer-running', Boolean(timer.running));

    if (toggleBtn) {
      toggleBtn.textContent = timer.running ? '⏸' : '▶';
      toggleBtn.title = timer.running ? 'Pausar temporizador' : 'Iniciar temporizador para todos';
    }
  }

  renderMusicControls() {
    if (!this.currentSession) return;
    const music = this.currentSession.music || { playing: false, style: 'zen' };

    // Synchronize Web Audio synthesizer with room state
    if (music.playing) {
      this.musicEngine.setStyle(music.style || 'zen');
      if (!this.musicEngine.isPlaying) {
        this.musicEngine.start(music.style || 'zen');
      }
    } else if (this.musicEngine.isPlaying) {
      this.musicEngine.stop();
    }

    const styleSelect = document.getElementById('music-style-select');
    const toggleBtn = document.getElementById('btn-music-toggle');
    const muteBtn = document.getElementById('btn-music-mute');
    const widget = document.getElementById('music-widget');

    if (styleSelect) {
      styleSelect.value = music.style || 'zen';
    }

    if (toggleBtn) {
      toggleBtn.textContent = music.playing ? '⏹' : '▶';
      toggleBtn.title = music.playing
        ? 'Detener música relajante para la sala'
        : 'Iniciar música relajante CC0 para la sala';
    }

    if (muteBtn) {
      muteBtn.classList.toggle('hidden', !music.playing);
      muteBtn.textContent = this.musicEngine.isLocallyMuted ? '🔇' : '🔊';
      muteBtn.title = this.musicEngine.isLocallyMuted
        ? 'Activar sonido de música en mi navegador'
        : 'Silenciar música en mi navegador';
    }

    if (widget) {
      widget.classList.toggle('music-active', Boolean(music.playing));
    }
  }

  // =========================================================================
  // SHARE LINKS (PRE-SESSION INIT LINK + SNAPSHOT ARCHIVE LINK)
  // =========================================================================

  getInviteRoomUrl() {
    if (!this.currentSession) return window.location.href;
    const base = window.location.origin + window.location.pathname;
    const initMeta = encodePayloadToUrl(createInitMetadata(this.currentSession));
    return `${base}#room=${encodeURIComponent(this.currentSession.id)}&init=${initMeta}`;
  }

  getFullSnapshotUrl() {
    if (!this.currentSession) return window.location.href;
    const base = window.location.origin + window.location.pathname;
    const stateEncoded = encodePayloadToUrl(this.currentSession);
    return `${base}#room=${encodeURIComponent(this.currentSession.id)}&state=${stateEncoded}`;
  }

  openShareModal() {
    if (!this.currentSession) return;
    const modal = document.getElementById('share-modal');
    const inviteInput = document.getElementById('share-invite-url');
    const snapshotInput = document.getElementById('share-snapshot-url');

    if (inviteInput) inviteInput.value = this.getInviteRoomUrl();
    if (snapshotInput) snapshotInput.value = this.getFullSnapshotUrl();
    modal.classList.remove('hidden');
  }

  openProfileModal() {
    const modal = document.getElementById('profile-modal');
    const nameInput = document.getElementById('profile-name-input');
    const colorInput = document.getElementById('profile-color-input');
    if (nameInput) nameInput.value = this.user.name || '';
    if (colorInput) colorInput.value = this.user.color || '#6366f1';
    modal.classList.remove('hidden');
    setTimeout(() => nameInput?.focus(), 50);
  }

  // =========================================================================
  // EVENT BINDINGS
  // =========================================================================

  bindGlobalEvents() {
    // Theme toggle
    document.getElementById('btn-theme-toggle')?.addEventListener('click', () => this.toggleTheme());

    // User profile modal open & save
    document.getElementById('user-profile-btn')?.addEventListener('click', () => this.openProfileModal());

    document.getElementById('profile-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const nameVal = document.getElementById('profile-name-input').value.trim();
      const colorVal = document.getElementById('profile-color-input').value;
      if (nameVal) {
        this.user.name = nameVal;
        this.user.color = colorVal;
        saveUserProfile(this.user);
        this.renderUserBadge();
        if (this.syncEngine) {
          this.syncEngine.updateUserProfile(this.user);
        }
        if (this.currentSession) {
          this.renderBoard();
        }
        document.getElementById('profile-modal').classList.add('hidden');
        this.showToast(`Perfil actualizado: ${this.user.name}`);
      }
    });

    // Create new session form
    document.getElementById('create-session-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = document.getElementById('create-title').value.trim() || 'Retrospectiva de Sprint';
      const sprint = document.getElementById('create-sprint').value.trim();
      const templateId = document.getElementById('create-template').value;
      const cardsBlurred = document.getElementById('create-blur').checked;
      const maxVotes = Number(document.getElementById('create-max-votes').value) || 5;
      const importFromId = document.getElementById('create-import-actions').value;

      const previousActions = importFromId ? getPendingActionsFromSession(importFromId) : [];

      const newSession = createEmptySession({
        title,
        sprint,
        templateId,
        cardsBlurred,
        maxVotes,
        createdBy: this.user.name,
        coordinatorId: this.user.id,
        previousActions
      });

      saveSession(newSession);
      const initMeta = encodePayloadToUrl(createInitMetadata(newSession));
      window.location.hash = `room=${encodeURIComponent(newSession.id)}&init=${initMeta}`;
    });

    // Join existing session by ID or Link
    document.getElementById('join-session-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const raw = document.getElementById('join-room-input').value.trim();
      if (!raw) return;

      if (raw.includes('#room=')) {
        const hashPart = raw.split('#')[1];
        window.location.hash = hashPart;
      } else {
        window.location.hash = `room=${encodeURIComponent(raw)}`;
      }
    });

    // History search input
    document.getElementById('history-search-input')?.addEventListener('input', (e) => {
      this.historySearchQuery = e.target.value;
      this.renderSessionHistory();
    });

    // Import JSON file button
    document.getElementById('import-json-input')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const imported = JSON.parse(reader.result);
          if (imported && imported.id && imported.columns) {
            const existing = loadSession(imported.id);
            const finalSession = existing ? mergeSessions(existing, imported) : imported;
            saveSession(finalSession);
            this.renderSessionHistory();
            this.showToast(`Sesión "${finalSession.title}" importada correctamente`);
          } else {
            this.showToast('El archivo JSON no tiene un formato de sesión válido', true);
          }
        } catch (err) {
          this.showToast('Error al leer el archivo JSON', true);
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    // Back to dashboard button
    document.getElementById('btn-back-dashboard')?.addEventListener('click', () => {
      window.location.hash = '';
    });

    // Share modal button
    document.getElementById('btn-open-share')?.addEventListener('click', () => {
      this.openShareModal();
    });

    // Copy buttons inside Share Modal
    document.getElementById('btn-copy-invite')?.addEventListener('click', () => {
      navigator.clipboard.writeText(this.getInviteRoomUrl());
      this.showToast('🔗 Enlace de sala copiado al portapapeles');
    });

    document.getElementById('btn-copy-snapshot')?.addEventListener('click', () => {
      navigator.clipboard.writeText(this.getFullSnapshotUrl());
      this.showToast('📦 Enlace con todas las tarjetas copiado al portapapeles');
    });

    document.getElementById('btn-export-markdown')?.addEventListener('click', () => {
      if (!this.currentSession) return;
      const md = exportSessionToMarkdown(this.currentSession);
      this.downloadFile(`${this.currentSession.title.toLowerCase().replace(/\s+/g, '-')}.md`, md, 'text/markdown');
      this.showToast('📄 Resumen Markdown descargado');
    });

    document.getElementById('btn-export-json')?.addEventListener('click', () => {
      if (!this.currentSession) return;
      const json = JSON.stringify(this.currentSession, null, 2);
      this.downloadFile(`${this.currentSession.id}.json`, json, 'application/json');
      this.showToast('💾 Copia de seguridad JSON descargada');
    });

    // Blur / Reveal toggle
    document.getElementById('btn-toggle-blur')?.addEventListener('click', () => {
      this.updateSession(s => {
        s.settings.cardsBlurred = !s.settings.cardsBlurred;
        if (!s.settings.cardsBlurred && s.settings.phase === 'write') {
          s.settings.phase = 'group';
        }
        s.settings.updatedAt = Date.now();
      });
    });

    // Sort by votes toggle
    document.getElementById('btn-sort-votes')?.addEventListener('click', () => {
      this.sortByVotes = !this.sortByVotes;
      this.renderBoard();
    });

    // Add new custom column
    document.getElementById('btn-add-column')?.addEventListener('click', () => {
      const title = prompt('Nombre de la nueva columna:', 'Ideas / Kudos');
      if (!title || !title.trim()) return;
      const isAction = confirm('¿Es una columna de Plan de Acción (con casillas de verificación y responsable)?');
      this.updateSession(s => {
        s.columns.push({
          id: generateId('col'),
          title: title.trim(),
          subtitle: '',
          color: isAction ? 'indigo' : 'sky',
          icon: 'sparkles',
          isActionColumn: isAction,
          order: s.columns.length,
          updatedAt: Date.now(),
          deleted: false
        });
      });
    });

    // Phase steps bar
    document.querySelectorAll('.phase-step').forEach(btn => {
      btn.addEventListener('click', () => {
        const nextPhase = btn.dataset.phase;
        this.updateSession(s => {
          s.settings.phase = nextPhase;
          // Automatically unblur when moving past the write phase
          if (nextPhase !== 'write' && s.settings.cardsBlurred) {
            s.settings.cardsBlurred = false;
          }
          s.settings.updatedAt = Date.now();
        });
        if (nextPhase === 'vote') {
          this.sortByVotes = true;
          this.renderBoard();
        }
      });
    });

    // Timer controls
    document.getElementById('btn-timer-toggle')?.addEventListener('click', () => {
      if (!this.currentSession) return;
      this.updateSession(s => {
        if (s.timer.running) {
          const left = Math.max(0, Math.ceil((s.timer.endsAt - Date.now()) / 1000));
          s.timer.running = false;
          s.timer.durationSec = left || 300;
          s.timer.endsAt = null;
        } else {
          const dur = s.timer.durationSec > 0 ? s.timer.durationSec : 300;
          s.timer.running = true;
          s.timer.durationSec = dur;
          s.timer.endsAt = Date.now() + dur * 1000;
        }
        s.timer.updatedAt = Date.now();
      });
    });

    document.getElementById('timer-preset-select')?.addEventListener('change', (e) => {
      const sec = Number(e.target.value) || 300;
      this.updateSession(s => {
        s.timer.running = false;
        s.timer.durationSec = sec;
        s.timer.endsAt = null;
        s.timer.updatedAt = Date.now();
      });
    });

    // Relaxing CC0 Music controls
    document.getElementById('btn-music-toggle')?.addEventListener('click', () => {
      if (!this.currentSession) return;
      this.updateSession(s => {
        s.music = s.music || { playing: false, style: 'zen', updatedAt: 0 };
        s.music.playing = !s.music.playing;
        s.music.updatedAt = Date.now();
      });
    });

    document.getElementById('music-style-select')?.addEventListener('change', (e) => {
      if (!this.currentSession) return;
      const nextStyle = e.target.value || 'zen';
      this.updateSession(s => {
        s.music = s.music || { playing: false, style: 'zen', updatedAt: 0 };
        s.music.style = nextStyle;
        s.music.updatedAt = Date.now();
      });
    });

    document.getElementById('btn-music-mute')?.addEventListener('click', () => {
      this.musicEngine.toggleLocalMute();
      this.renderMusicControls();
    });

    // Delegated clicks across the page
    document.addEventListener('click', (e) => {
      // Close modals when clicking backdrop or close button
      if (e.target.matches('[data-close-modal]') || e.target.classList.contains('modal-backdrop')) {
        document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.add('hidden'));
        return;
      }

      // Banner reveal button
      if (e.target.id === 'banner-reveal-btn') {
        this.updateSession(s => {
          s.settings.cardsBlurred = false;
          s.settings.phase = 'group';
          s.settings.updatedAt = Date.now();
        });
        return;
      }

      if (e.target.id === 'banner-sort-votes-btn') {
        this.sortByVotes = !this.sortByVotes;
        this.renderBoard();
        return;
      }

      const actionEl = e.target.closest('[data-action]');
      if (!actionEl) return;

      const action = actionEl.dataset.action;
      const id = actionEl.dataset.id;
      const cardId = actionEl.dataset.cardId;

      switch (action) {
        case 'open-history': {
          const sess = loadSession(id);
          if (sess) {
            const initMeta = encodePayloadToUrl(createInitMetadata(sess));
            window.location.hash = `room=${encodeURIComponent(sess.id)}&init=${initMeta}`;
          }
          break;
        }
        case 'carry-over': {
          const oldSess = loadSession(id);
          if (!oldSess) break;
          const select = document.getElementById('create-import-actions');
          if (select) {
            this.populatePreviousSessionSelect();
            select.value = id;
          }
          const titleInput = document.getElementById('create-title');
          if (titleInput) {
            titleInput.value = `${oldSess.title} (Continuación)`;
            titleInput.focus();
          }
          window.scrollTo({ top: 0, behavior: 'smooth' });
          this.showToast('Acciones pendientes seleccionadas en el formulario de nueva sesión');
          break;
        }
        case 'export-md-history': {
          const sess = loadSession(id);
          if (sess) {
            const md = exportSessionToMarkdown(sess);
            this.downloadFile(`${sess.title.toLowerCase().replace(/\s+/g, '-')}.md`, md, 'text/markdown');
          }
          break;
        }
        case 'delete-history': {
          if (confirm('¿Seguro que quieres eliminar esta sesión del historial de este navegador?')) {
            deleteSession(id);
            this.renderSessionHistory();
            this.populatePreviousSessionSelect();
            this.showToast('Sesión eliminada del historial');
          }
          break;
        }
        case 'vote-up': {
          if (this.getRemainingVotes() <= 0) {
            this.showToast(`Has alcanzado el límite de ${this.currentSession.settings?.maxVotes || 5} votos`, true);
            break;
          }
          this.updateSession(s => {
            const card = s.cards[cardId];
            if (!card) return;
            card.votes = card.votes || {};
            const currentCount = Number(card.votes[this.user.id]?.count || 0);
            card.votes[this.user.id] = {
              count: currentCount + 1,
              updatedAt: Date.now()
            };
            card.updatedAt = Date.now();
          });
          break;
        }
        case 'vote-down': {
          this.updateSession(s => {
            const card = s.cards[cardId];
            if (!card || !card.votes?.[this.user.id]) return;
            const currentCount = Number(card.votes[this.user.id].count || 0);
            card.votes[this.user.id] = {
              count: Math.max(0, currentCount - 1),
              updatedAt: Date.now()
            };
            card.updatedAt = Date.now();
          });
          break;
        }
        case 'toggle-comments': {
          if (this.openCommentCards.has(cardId)) {
            this.openCommentCards.delete(cardId);
          } else {
            this.openCommentCards.add(cardId);
          }
          this.renderBoard();
          break;
        }
        case 'edit-card': {
          this.editingCardId = cardId;
          this.renderBoard();
          break;
        }
        case 'cancel-edit': {
          this.editingCardId = null;
          this.renderBoard();
          break;
        }
        case 'delete-card': {
          this.updateSession(s => {
            if (s.cards[cardId]) {
              s.cards[cardId].deleted = true;
              s.cards[cardId].updatedAt = Date.now();
            }
          });
          break;
        }
        case 'convert-to-action': {
          const card = this.currentSession?.cards?.[cardId];
          if (!card) break;
          const actionCol = this.currentSession.columns.find(c => !c.deleted && c.isActionColumn)
            || this.currentSession.columns[this.currentSession.columns.length - 1];
          const assignee = prompt('¿Quién será responsable de esta acción? (opcional):', '');
          if (assignee === null) break;
          this.updateSession(s => {
            const newId = generateId('card');
            s.cards[newId] = {
              id: newId,
              columnId: actionCol.id,
              text: card.text,
              authorId: this.user.id,
              authorName: this.user.name,
              authorColor: this.user.color,
              Assignee: assignee.trim(),
              done: false,
              votes: {},
              comments: {},
              createdAt: Date.now(),
              updatedAt: Date.now(),
              deleted: false
            };
          });
          this.showToast('⚡ Tarjeta copiada al Plan de Acción');
          break;
        }
        case 'toggle-action-done': {
          this.updateSession(s => {
            const card = s.cards[cardId];
            if (card) {
              card.done = !card.done;
              card.updatedAt = Date.now();
            }
          });
          break;
        }
        case 'edit-column-title': {
          const colId = actionEl.dataset.colId;
          const col = this.currentSession?.columns?.find(c => c.id === colId);
          if (!col) break;
          const nextTitle = prompt('Nuevo título para la columna:', col.title);
          if (nextTitle && nextTitle.trim()) {
            this.updateSession(s => {
              const target = s.columns.find(c => c.id === colId);
              if (target) {
                target.title = nextTitle.trim();
                target.updatedAt = Date.now();
              }
            });
          }
          break;
        }
      }
    });

    // Delegated form submissions inside board (Add Card, Edit Card, Add Comment)
    document.addEventListener('submit', (e) => {
      if (e.target.classList.contains('add-card-form')) {
        e.preventDefault();
        const form = e.target;
        const colId = form.dataset.colId;
        const textInput = form.querySelector('textarea[name="cardText"]');
        const assigneeInput = form.querySelector('input[name="assignee"]');
        const text = textInput?.value.trim();
        if (!text) return;

        const assignee = assigneeInput ? assigneeInput.value.trim() : '';
        this.updateSession(s => {
          const id = generateId('card');
          s.cards[id] = {
            id,
            columnId: colId,
            text,
            authorId: this.user.id,
            authorName: this.user.name,
            authorColor: this.user.color,
            Assignee: assignee,
            done: false,
            votes: {},
            comments: {},
            createdAt: Date.now(),
            updatedAt: Date.now(),
            deleted: false
          };
        });

        // Re-focus textarea in that column so user can quickly add multiple cards
        const newFormTextarea = document.querySelector(`.add-card-form[data-col-id="${colId}"] textarea`);
        newFormTextarea?.focus();
        return;
      }

      if (e.target.classList.contains('edit-card-form')) {
        e.preventDefault();
        const form = e.target;
        const cardId = form.dataset.cardId;
        const nextText = form.querySelector('textarea[name="editText"]')?.value.trim();
        const nextAssignee = form.querySelector('input[name="editAssignee"]')?.value.trim() ?? '';
        if (!nextText) return;

        this.editingCardId = null;
        this.updateSession(s => {
          const card = s.cards[cardId];
          if (card) {
            card.text = nextText;
            if (form.querySelector('input[name="editAssignee"]')) {
              card.Assignee = nextAssignee;
            }
            card.updatedAt = Date.now();
          }
        });
        return;
      }

      if (e.target.classList.contains('add-comment-form')) {
        e.preventDefault();
        const form = e.target;
        const cardId = form.dataset.cardId;
        const input = form.querySelector('input[name="commentText"]');
        const text = input?.value.trim();
        if (!text) return;

        this.updateSession(s => {
          const card = s.cards[cardId];
          if (!card) return;
          card.comments = card.comments || {};
          const cid = generateId('cm');
          card.comments[cid] = {
            id: cid,
            text,
            authorId: this.user.id,
            authorName: this.user.name,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            deleted: false
          };
          card.updatedAt = Date.now();
        });
        return;
      }
    });

    // Submit add-card textarea on Enter (without Shift)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && e.target.matches('.add-card-form textarea')) {
        e.preventDefault();
        e.target.closest('form')?.requestSubmit();
      }
    });

    // Drag and Drop cards between columns
    document.addEventListener('dragstart', (e) => {
      const cardEl = e.target.closest('.retro-card[draggable="true"]');
      if (!cardEl) return;
      this.draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    document.addEventListener('dragend', (e) => {
      const cardEl = e.target.closest('.retro-card');
      cardEl?.classList.remove('dragging');
      document.querySelectorAll('.cards-list.drag-over').forEach(el => el.classList.remove('drag-over'));
      this.draggedCardId = null;
    });

    document.addEventListener('dragover', (e) => {
      const dropZone = e.target.closest('[data-drop-col]');
      if (!dropZone || !this.draggedCardId) return;
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });

    document.addEventListener('dragleave', (e) => {
      const dropZone = e.target.closest('[data-drop-col]');
      if (dropZone && !dropZone.contains(e.relatedTarget)) {
        dropZone.classList.remove('drag-over');
      }
    });

    document.addEventListener('drop', (e) => {
      const dropZone = e.target.closest('[data-drop-col]');
      if (!dropZone || !this.draggedCardId) return;
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const targetColId = dropZone.dataset.dropCol;
      const cardId = this.draggedCardId;
      this.draggedCardId = null;

      this.updateSession(s => {
        const card = s.cards[cardId];
        if (card && card.columnId !== targetColId) {
          card.columnId = targetColId;
          card.updatedAt = Date.now();
        }
      });
    });
  }

  // =========================================================================
  // UTILITIES
  // =========================================================================

  downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  showToast(message, isError = false) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${isError ? 'toast-error' : ''}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  formatCardText(str) {
    return this.escapeHtml(str).replace(/\n/g, '<br>');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.freeRetroApp = new FreeRetroApp();
});

