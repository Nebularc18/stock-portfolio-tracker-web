// ── Navigation ──
const navLinks = document.querySelectorAll('.nav [data-view]');
const views = document.querySelectorAll('.view');

const setActiveView = (target) => {
  if (!target) return;
  navLinks.forEach((link) => {
    const isActive = link.dataset.view === target;
    link.classList.toggle('active', isActive);
    link.setAttribute('aria-selected', isActive ? 'true' : 'false');
    link.setAttribute('tabindex', isActive ? '0' : '-1');
  });
  views.forEach((view) => {
    const isActive = view.id === 'view-' + target;
    view.classList.toggle('active', isActive);
    view.setAttribute('aria-hidden', isActive ? 'false' : 'true');
  });
};

navLinks.forEach(link => {
  link.addEventListener('click', function(e) {
    e.preventDefault();
    setActiveView(this.dataset.view);
    this.focus();
  });
});

const navContainer = document.querySelector('.nav');
const focusNavLinkAt = (index) => {
  const links = Array.from(navLinks);
  if (!links.length) return;
  const targetIndex = (index + links.length) % links.length;
  const link = links[targetIndex];
  if (!link) return;
  setActiveView(link.dataset.view);
  link.focus();
};

const handleNavKeydown = (event) => {
  const { key } = event;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
  const links = Array.from(navLinks);
  if (!links.length) return;
  event.preventDefault();
  const activeIndex = links.indexOf(document.activeElement);
  let nextIndex = activeIndex >= 0 ? activeIndex : 0;
  if (key === 'ArrowLeft') {
    nextIndex = activeIndex >= 0 ? (activeIndex - 1 + links.length) % links.length : links.length - 1;
  } else if (key === 'ArrowRight') {
    nextIndex = activeIndex >= 0 ? (activeIndex + 1) % links.length : 0;
  } else if (key === 'Home') {
    nextIndex = 0;
  } else if (key === 'End') {
    nextIndex = links.length - 1;
  }
  focusNavLinkAt(nextIndex);
};

if (navContainer) {
  navContainer.addEventListener('keydown', handleNavKeydown);
}

const initialActive = document.querySelector('.nav [data-view].active');
if (initialActive) {
  setActiveView(initialActive.dataset.view);
}

const initInteractive = () => {
  const searchInput = document.getElementById('searchInput');
  const searchResults = Array.from(document.querySelectorAll('.search-results .result-card'));
  const searchEmpty = document.getElementById('searchEmpty');
  const searchHint = document.querySelector('.search-hint');
  let searchTimer;

  const applySearch = (query) => {
    const normalized = (query || '').trim().toLowerCase();
    let visibleCount = 0;
    searchResults.forEach((card) => {
      const matches = normalized === '' || (card.textContent || '').toLowerCase().includes(normalized);
      card.style.display = matches ? '' : 'none';
      if (matches) visibleCount += 1;
    });
    if (searchEmpty) {
      searchEmpty.style.display = visibleCount === 0 ? 'block' : 'none';
    }
    if (searchHint) {
      searchHint.style.display = normalized === '' ? '' : 'none';
    }
  };

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => applySearch(searchInput.value), 140);
    });
    applySearch(searchInput.value);
  }

  const alertButtons = Array.from(document.querySelectorAll('.alert-add-btn'));
  const alertFeedback = document.getElementById('alertFeedback');
  const setAlertButtonsDisabled = (disabled) => {
    alertButtons.forEach((btn) => {
      btn.disabled = disabled;
      btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    });
  };

  const showAlertFeedback = (message, isError = false) => {
    if (!alertFeedback) return;
    alertFeedback.textContent = message;
    alertFeedback.classList.toggle('error', isError);
    alertFeedback.classList.toggle('success', !isError);
    if (alertFeedback.dataset.timer) {
      window.clearTimeout(Number(alertFeedback.dataset.timer));
    }
    const timer = window.setTimeout(() => {
      alertFeedback.textContent = '';
      alertFeedback.classList.remove('error', 'success');
    }, 3000);
    alertFeedback.dataset.timer = String(timer);
  };

  const createPriceAlert = async (payload) => {
    return Promise.resolve(payload);
  };

  const createDividendReminder = async (payload) => {
    return Promise.resolve(payload);
  };

  const modalState = new WeakMap();
  const getFocusableElements = (container) => {
    return Array.from(container.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true');
  };

  const disableBackgroundFocus = (modal) => {
    const focusables = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]'));
    const disabled = [];
    focusables.forEach((el) => {
      if (modal.contains(el)) return;
      const prevTabindex = el.getAttribute('tabindex');
      const prevAriaHidden = el.getAttribute('aria-hidden');
      el.setAttribute('tabindex', '-1');
      el.setAttribute('aria-hidden', 'true');
      disabled.push({ el, prevTabindex, prevAriaHidden });
    });
    return disabled;
  };

  const restoreBackgroundFocus = (disabled) => {
    disabled.forEach(({ el, prevTabindex, prevAriaHidden }) => {
      if (prevTabindex === null || prevTabindex === undefined) {
        el.removeAttribute('tabindex');
      } else {
        el.setAttribute('tabindex', prevTabindex);
      }
      if (prevAriaHidden === null || prevAriaHidden === undefined) {
        el.removeAttribute('aria-hidden');
      } else {
        el.setAttribute('aria-hidden', prevAriaHidden);
      }
    });
  };

  const openAlertModal = (modalId) => {
    const modal = document.getElementById(modalId);
    setAlertButtonsDisabled(true);
    if (!modal) {
      setAlertButtonsDisabled(false);
      return;
    }
    const restoreFocusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backgroundFocus = disableBackgroundFocus(modal);
    const keydownHandler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAlertModal(modal);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = getFocusableElements(modal);
      if (focusables.length === 0) {
        event.preventDefault();
        const fallback = modal.querySelector('.alert-modal-card');
        if (fallback) fallback.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey) {
        if (document.activeElement === first || document.activeElement === modal) {
          event.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    modalState.set(modal, { keydownHandler, restoreFocusTarget, backgroundFocus });
    modal.addEventListener('keydown', keydownHandler);
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    modal.setAttribute('aria-busy', 'true');
    window.setTimeout(() => {
      modal.setAttribute('aria-busy', 'false');
      setAlertButtonsDisabled(false);
      const focusables = getFocusableElements(modal);
      const focusTarget = focusables[0] || modal.querySelector('.alert-modal-card');
      if (focusTarget) focusTarget.focus();
    }, 150);
  };

  const closeAlertModal = (modal) => {
    const state = modalState.get(modal);
    if (state?.keydownHandler) {
      modal.removeEventListener('keydown', state.keydownHandler);
    }
    if (state?.backgroundFocus) {
      restoreBackgroundFocus(state.backgroundFocus);
    }
    modalState.delete(modal);
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    modal.setAttribute('aria-busy', 'false');
    setAlertButtonsDisabled(false);
    if (state?.restoreFocusTarget && document.contains(state.restoreFocusTarget)) {
      state.restoreFocusTarget.focus();
    }
  };

  const handleCreateAlert = async (modal) => {
    const inputs = Array.from(modal.querySelectorAll('input'));
    const ticker = (inputs[0]?.value || '').trim();
    const targetPrice = Number(inputs[1]?.value);
    if (!ticker || !Number.isFinite(targetPrice) || targetPrice <= 0) {
      showAlertFeedback('Enter a valid ticker and target price.', true);
      return;
    }
    try {
      await createPriceAlert({ ticker, targetPrice });
      showAlertFeedback(`Alert created for ${ticker}.`, false);
      closeAlertModal(modal);
    } catch (err) {
      console.error('Failed to create alert', err);
      showAlertFeedback('Unable to create alert right now.', true);
    }
  };

  const handleCreateReminder = async (modal) => {
    const inputs = Array.from(modal.querySelectorAll('input'));
    const ticker = (inputs[0]?.value || '').trim();
    const reminderDays = Number(inputs[1]?.value);
    if (!ticker || !Number.isFinite(reminderDays) || reminderDays <= 0) {
      showAlertFeedback('Enter a valid ticker and reminder window.', true);
      return;
    }
    try {
      await createDividendReminder({ ticker, reminderDays });
      showAlertFeedback(`Reminder created for ${ticker}.`, false);
      closeAlertModal(modal);
    } catch (err) {
      console.error('Failed to create reminder', err);
      showAlertFeedback('Unable to create reminder right now.', true);
    }
  };

  document.querySelectorAll('[data-action=\'new-price-alert\']').forEach((btn) => {
    btn.addEventListener('click', () => openAlertModal('alert-modal-price'));
  });
  document.querySelectorAll('[data-action=\'new-dividend-reminder\']').forEach((btn) => {
    btn.addEventListener('click', () => openAlertModal('alert-modal-dividend'));
  });

  document.querySelectorAll('.alert-modal').forEach((modal) => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeAlertModal(modal);
    });
  });
  document.querySelectorAll('[data-modal-close]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('.alert-modal');
      if (modal) closeAlertModal(modal);
    });
  });

  document.querySelectorAll('[data-modal-submit="price"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('.alert-modal');
      if (modal) {
        void handleCreateAlert(modal);
      }
    });
  });
  document.querySelectorAll('[data-modal-submit="dividend"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('.alert-modal');
      if (modal) {
        void handleCreateReminder(modal);
      }
    });
  });
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initInteractive);
} else {
  initInteractive();
}
// ── Period buttons ──
document.querySelectorAll('.pbtns').forEach(group => {
  group.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', function() {
      group.querySelectorAll('button').forEach(b => {
        b.classList.remove('a');
        b.setAttribute('aria-pressed', 'false');
      });
      this.classList.add('a');
      this.setAttribute('aria-pressed', 'true');
    });
  });
});

// ── Transaction filters ──
document.querySelectorAll('.tx-filter-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    const filter = this.dataset.filter || 'all';
    document.querySelectorAll('.tx-filter-btn').forEach(b => {
      b.classList.remove('a');
      b.setAttribute('aria-pressed', 'false');
    });
    this.classList.add('a');
    this.setAttribute('aria-pressed', 'true');
    document.querySelectorAll('.tx-item').forEach(item => {
      item.style.display = filter === 'all' || item.dataset.type === filter ? '' : 'none';
    });
  });
});

document.querySelectorAll('.acct-nav-item:not([aria-disabled="true"])').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.acct-nav-item:not([aria-disabled="true"])').forEach(item => {
      item.classList.remove('a');
      item.setAttribute('aria-pressed', 'false');
    });
    this.classList.add('a');
    this.setAttribute('aria-pressed', 'true');
  });
});

// ── Chart crosshair / tooltip ──
(function() {
  const wrap = document.getElementById('chartWrap');
  const svg = document.getElementById('chartSvg');
  const tooltip = document.getElementById('chartTooltip');
  const ctVal = document.getElementById('ctVal');
  const ctDt = document.getElementById('ctDt');
  const crosshair = document.getElementById('crosshair');
  const dot = document.getElementById('crosshairDot');

  // Data points: [x in 0-640, y in 0-185, value, date]
  const pts = [
    [0, 162, '749,000', 'Dec 1'],
    [80, 158, '758,000', 'Dec 20'],
    [160, 153, '762,000', 'Jan 5'],
    [240, 148, '771,500', 'Jan 20'],
    [320, 136, '784,000', 'Feb 5'],
    [400, 127, '796,000', 'Feb 20'],
    [480, 105, '813,000', 'Mar 1'],
    [560, 91, '828,000', 'Mar 7'],
    [640, 78, '842,341', 'Mar 10'],
  ];

  if (!wrap || !svg) return;

  wrap.addEventListener('mousemove', function(e) {
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const svgX = (mx / rect.width) * 640;

    // Find nearest point
    let nearest = pts[0];
    let minD = Infinity;
    pts.forEach(p => {
      const d = Math.abs(p[0] - svgX);
      if (d < minD) { minD = d; nearest = p; }
    });

    const svgY = nearest[1];
    // Convert SVG coords to DOM pixels
    const domX = (nearest[0] / 640) * rect.width;
    const domY = (svgY / 185) * rect.height;

    crosshair.setAttribute('x1', nearest[0]);
    crosshair.setAttribute('x2', nearest[0]);
    crosshair.setAttribute('display', '');
    dot.setAttribute('cx', nearest[0]);
    dot.setAttribute('cy', svgY);
    dot.setAttribute('display', '');

    ctVal.textContent = nearest[2] + ' SEK';
    ctDt.textContent = nearest[3] + ', 2025–26';
    tooltip.style.opacity = '1';

    // Position tooltip, avoid edge overflow
    let tx = domX + 12;
    if (tx + 130 > rect.width) tx = domX - 130;
    tooltip.style.left = tx + 'px';
    tooltip.style.top = (domY - 20) + 'px';
  });

  wrap.addEventListener('mouseleave', function() {
    crosshair.setAttribute('display', 'none');
    dot.setAttribute('display', 'none');
    tooltip.style.opacity = '0';
  });
})();

// ── Clock ──
(function() {
  function pad(n) { return String(n).padStart(2,'0'); }
  const timeEl = document.querySelector('.tb-time');
  if (!timeEl) return;
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  function tick() {
    const now = new Date();
    const d = now.getDate();
    const m = months[now.getMonth()];
    const y = now.getFullYear();
    const h = pad(now.getHours());
    const min = pad(now.getMinutes());
    let dot = timeEl.querySelector('.live-dot');
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'live-dot';
      timeEl.textContent = '';
      timeEl.appendChild(dot);
    }
    let textNode = dot.nextSibling;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
      textNode = document.createTextNode('');
      timeEl.appendChild(textNode);
    }
    textNode.textContent = ` ${d} ${m} ${y} · ${h}:${min}`;
  }
  tick();
  setInterval(tick, 30000);
})();
