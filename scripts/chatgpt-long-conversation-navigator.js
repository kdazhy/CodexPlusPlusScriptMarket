// ==UserScript==
// @name         ChatGPT 长对话导航与预览（Codex++）
// @namespace    https://github.com/kdazhy
// @version      6.1.0
// @description  为 ChatGPT Windows 桌面端长对话提供提问索引、悬浮预览、精确跳转和快捷键导航。
// @author       kdazhy
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '6.1.0';
  const INSTALL_KEY = '__codexPlusChatConversationNavigator';
  const LOCK_ID = 'cgpt-codex-navigator-lock';
  const HOST_ID = 'cgpt-codex-navigator-v6-host';
  const LEGACY_STYLE_ID = 'cgpt-codex-navigator-v6-legacy-shield';

  const CONFIG = {
    right: 10,
    collapsedWidth: 54,
    expandedWidth: 430,
    rowHeight: 38,
    maxShellHeightRatio: 0.72,

    normalWidth: 8,
    near2Width: 11,
    near1Width: 17,
    activeWidth: 25,
    hoverWidth: 38,

    animationMs: 190,
    smoothScroll: true,

    titleMaxChars: 72,
    scanDebounceMs: 180,
    routePollMs: 900,
    jumpCorrectionMs: 650,
  };

  // =========================================================
  // 1. Codex++ 热重载与 DOM 单例
  // =========================================================
  // Codex++ 的“重新加载用户脚本”会再次 evaluate 当前文件，因此先销毁旧实例。
  const previous = window[INSTALL_KEY];
  if (previous && typeof previous.destroy === 'function') {
    try {
      previous.destroy();
    } catch (error) {
      console.warn('[ChatGPT Navigator v6] 清理旧实例失败，将强制接管。', error);
    }
  }

  function installDomLock() {
    document.getElementById(LOCK_ID)?.remove();
    const lock = document.createElement('meta');
    lock.id = LOCK_ID;
    lock.dataset.version = VERSION;
    lock.dataset.hostId = HOST_ID;
    document.documentElement.appendChild(lock);
  }

  // =========================================================
  // 2. 清理 / 屏蔽已知旧版本
  // =========================================================

  function installLegacyShield() {
    let style = document.getElementById(LEGACY_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = LEGACY_STYLE_ID;
      document.documentElement.appendChild(style);
    }

    style.textContent = `
      #cgpt-nav-root,
      #cgpt-codex-nav-root-v2,
      #cgpt-codex-nav-tooltip-v2,
      #cgpt-codex-nav-root-v3,
      #cgpt-codex-navigator-v4-host,
      #cgpt-codex-navigator-v5-host {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;
  }

  function removeStaleHosts() {
    document
      .querySelectorAll([
        '#cgpt-codex-navigator-v4-host',
        '#cgpt-codex-navigator-v5-host',
        `#${HOST_ID}`,
      ].join(','))
      .forEach(el => el.remove());
  }

  removeStaleHosts();
  installDomLock();
  installLegacyShield();

  // =========================================================
  // 3. 状态
  // =========================================================

  const state = {
    host: null,
    shadow: null,
    shell: null,
    body: null,
    count: null,

    items: [],
    activeIndex: -1,
    hoverIndex: -1,
    conversationRoot: null,
    scrollRoot: null,

    currentRouteKey: '',
    destroyed: false,
    scanTimer: null,
    lateScanTimer: null,
    jumpCorrectionTimer: null,
    scrollRAF: null,
    mutationObserver: null,
    routeTimer: null,
    domReadyHandler: null,
    initialized: false,
  };

  // =========================================================
  // 4. ChatGPT 消息提取
  // =========================================================

  function normalizeText(text) {
    return (text || '')
      .replace(/\u00A0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  function oneLine(text) {
    return normalizeText(text).replace(/\s*\n\s*/g, ' ');
  }

  function truncate(text, maxChars = CONFIG.titleMaxChars) {
    const chars = Array.from(text);
    return chars.length > maxChars
      ? chars.slice(0, maxChars).join('') + '…'
      : text;
  }

  function getConversationRoot() {
    const candidates = [
      ...document.querySelectorAll([
        '[data-thread-find-target="conversation"]',
        '[data-testid="conversation-turn-list"]',
        'main',
      ].join(',')),
    ];

    let best = null;
    let bestCount = -1;

    for (const candidate of candidates) {
      const count = candidate.querySelectorAll([
        '[data-user-message-bubble]',
        '[data-message-author-role="user"]',
        '[data-testid="user-message"]',
        '[data-message-role="user"]',
      ].join(',')).length;

      if (count > bestCount) {
        best = candidate;
        bestCount = count;
      }
    }

    return best || document.body || document.documentElement;
  }

  function getUserMessageNodes(root = getConversationRoot()) {
    const selector = [
      '[data-user-message-bubble]',
      '[data-message-author-role="user"]',
      '[data-testid="user-message"]',
      '[data-message-role="user"]',
    ].join(',');

    return [...root.querySelectorAll(selector)].filter(node => {
      const parentUserNode = node.parentElement?.closest(selector);
      return !parentUserNode || !root.contains(parentUserNode);
    });
  }

  function getScrollTarget(messageNode) {
    return (
      messageNode.closest('[data-local-conversation-user-anchor]') ||
      messageNode.closest('[data-turn-key]') ||
      messageNode.closest('[data-content-search-turn-key]') ||
      messageNode.closest('[data-testid^="conversation-turn-"]') ||
      messageNode.closest('[data-thread-find-target^="message"]') ||
      messageNode.closest('[data-message-id]') ||
      messageNode.closest('article') ||
      messageNode
    );
  }

  function extractMessageText(node) {
    const preferred =
      node.querySelector('.whitespace-pre-wrap') ||
      node.querySelector('[class*="whitespace-pre-wrap"]') ||
      node.querySelector('[data-message-content]') ||
      node.querySelector('[data-testid="user-message"]') ||
      node.querySelector('[class*="markdown"]') ||
      node;

    const text = oneLine(preferred.innerText || preferred.textContent || '');
    if (text) return text;

    const attachmentCount = node.querySelectorAll([
      'img',
      '[data-testid*="attachment"]',
      '[data-message-attachment]',
    ].join(',')).length;

    return attachmentCount ? `附件消息（${attachmentCount} 个附件）` : '';
  }

  function findScrollRoot(node) {
    let current = node?.parentElement || null;

    while (current && current !== document.documentElement) {
      const style = getComputedStyle(current);
      const canScroll = /(auto|scroll|overlay)/.test(style.overflowY);
      if (canScroll && current.clientHeight > 0 && current.scrollHeight > current.clientHeight + 8) {
        return current;
      }
      current = current.parentElement;
    }

    return document.scrollingElement || document.documentElement;
  }

  function getViewportMetrics() {
    const root = state.scrollRoot;
    if (!root || root === document.body || root === document.documentElement || root === document.scrollingElement) {
      return { top: 0, bottom: window.innerHeight, height: window.innerHeight };
    }

    const rect = root.getBoundingClientRect();
    const top = Math.max(0, rect.top);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    return { top, bottom, height: Math.max(1, bottom - top) };
  }

  function getRouteKey() {
    const activeThread = document.querySelector([
      '[data-app-action-sidebar-thread-id][aria-current="page"]',
      '[data-app-action-sidebar-thread-id][data-state="active"]',
      '[data-app-action-sidebar-thread-id][aria-selected="true"]',
    ].join(','));

    const threadId = activeThread?.getAttribute('data-app-action-sidebar-thread-id') || '';
    const conversationId =
      document.querySelector('[data-above-composer-conversation-id]')
        ?.getAttribute('data-above-composer-conversation-id') ||
      document.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-id') ||
      '';

    return `${location.href}|${threadId}|${conversationId}`;
  }

  // =========================================================
  // 5. UI
  // =========================================================

  function createUI() {
    state.host?.remove();

    const host = document.createElement('div');
    host.id = HOST_ID;

    Object.assign(host.style, {
      position: 'fixed',
      inset: '0',
      width: '0',
      height: '0',
      zIndex: '2147483647',
      pointerEvents: 'none',
    });

    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        :host { all: initial; color-scheme: inherit; }
        * { box-sizing: border-box; }

        .empty {
          padding: 18px 14px 20px;
          text-align: center;
          font-size: 12px;
          opacity: .5;
        }

        /* v6.1：参考 rewrite v1.1 的单 shell / 单行模型。 */
        #shell {
          position: fixed;
          right: ${CONFIG.right}px;
          top: 50%;
          z-index: 2147483647;

          width: ${CONFIG.collapsedWidth}px;
          max-width: calc(100vw - 20px);
          max-height: ${Math.round(CONFIG.maxShellHeightRatio * 100)}vh;

          display: flex;
          flex-direction: column;

          color: CanvasText;
          font-family:
            "Segoe UI Variable Text", "Segoe UI", "PingFang SC",
            "Microsoft YaHei", ui-sans-serif, sans-serif;

          border: 1px solid transparent;
          border-radius: 18px;
          background: transparent;
          box-shadow: none;

          overflow: hidden;
          isolation: isolate;
          pointer-events: auto;
          user-select: none;

          transform: translateY(-50%);
          transform-origin: right center;

          transition:
            width ${CONFIG.animationMs}ms cubic-bezier(.2,.8,.2,1),
            background-color ${CONFIG.animationMs}ms ease,
            border-color ${CONFIG.animationMs}ms ease,
            box-shadow ${CONFIG.animationMs}ms ease;
        }

        #shell[data-empty="true"] {
          display: none;
        }

        #shell:hover,
        #shell:focus-within {
          width: min(${CONFIG.expandedWidth}px, calc(100vw - 20px));
          border-color: color-mix(in srgb, CanvasText 11%, transparent);
          background:
            linear-gradient(
              135deg,
              color-mix(in srgb, Canvas 98%, transparent),
              color-mix(in srgb, Canvas 92%, CanvasText 3%)
            );
          box-shadow:
            0 24px 68px rgba(0,0,0,.14),
            0 8px 24px rgba(0,0,0,.08),
            inset 0 1px 0 color-mix(in srgb, Canvas 78%, transparent);
          backdrop-filter: blur(18px) saturate(1.15);
          -webkit-backdrop-filter: blur(18px) saturate(1.15);
        }

        #header {
          flex: 0 0 auto;
          min-height: 0;
          height: 0;
          padding: 0 15px;

          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;

          overflow: hidden;
          border-bottom: 0;
          box-shadow: none;
          opacity: 0;
          visibility: hidden;
          transform: translateY(-4px);

          transition:
            height ${CONFIG.animationMs}ms cubic-bezier(.2,.8,.2,1),
            min-height ${CONFIG.animationMs}ms cubic-bezier(.2,.8,.2,1),
            opacity 120ms ease,
            transform ${CONFIG.animationMs}ms cubic-bezier(.2,.8,.2,1),
            visibility 120ms step-end,
            box-shadow ${CONFIG.animationMs}ms ease;
        }

        #shell:hover #header,
        #shell:focus-within #header {
          min-height: 48px;
          height: 48px;
          box-shadow: inset 0 -1px 0 color-mix(in srgb, CanvasText 8%, transparent);
          opacity: 1;
          visibility: visible;
          transform: translateY(0);

          transition:
            height ${CONFIG.animationMs}ms cubic-bezier(.2,.8,.2,1),
            min-height ${CONFIG.animationMs}ms cubic-bezier(.2,.8,.2,1),
            opacity 120ms ease 45ms,
            transform ${CONFIG.animationMs}ms cubic-bezier(.2,.8,.2,1),
            visibility 0s,
            box-shadow ${CONFIG.animationMs}ms ease;
        }

        .brand,
        .meta {
          display: flex;
          align-items: center;
          min-width: 0;
        }

        .brand { gap: 8px; }
        .meta { gap: 9px; white-space: nowrap; }

        .brand-mark {
          width: 7px;
          height: 7px;
          flex: 0 0 auto;
          border-radius: 999px;
          background: color-mix(in srgb, AccentColor 74%, CanvasText 26%);
          box-shadow: 0 0 0 4px color-mix(in srgb, AccentColor 12%, transparent);
        }

        .brand-title {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 13px;
          font-weight: 650;
          letter-spacing: .01em;
        }

        #count {
          font-size: 11px;
          font-variant-numeric: tabular-nums;
          opacity: .52;
        }

        kbd {
          padding: 2px 6px 3px;
          border: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
          border-radius: 6px;
          background: color-mix(in srgb, CanvasText 5%, transparent);
          font: inherit;
          font-size: 10px;
          line-height: 1;
          opacity: .6;
        }

        #body {
          min-height: 0;
          padding: 0;
          overflow-x: hidden;
          overflow-y: auto;
          overscroll-behavior: contain;
          scrollbar-width: none;
        }

        #body::-webkit-scrollbar { width: 0; height: 0; }

        #shell:hover #body,
        #shell:focus-within #body {
          padding: 7px;
          scrollbar-width: thin;
          scrollbar-color: color-mix(in srgb, CanvasText 18%, transparent) transparent;
        }

        #shell:hover #body::-webkit-scrollbar,
        #shell:focus-within #body::-webkit-scrollbar { width: 6px; }

        #shell:hover #body::-webkit-scrollbar-thumb,
        #shell:focus-within #body::-webkit-scrollbar-thumb {
          border: 2px solid transparent;
          border-radius: 999px;
          background: color-mix(in srgb, CanvasText 20%, transparent);
          background-clip: padding-box;
        }

        .nav-row {
          position: relative;
          width: 100%;
          height: ${CONFIG.rowHeight}px;
          min-height: ${CONFIG.rowHeight}px;
          margin: 0;
          padding: 0;

          display: grid;
          grid-template-columns: minmax(0, 1fr) ${CONFIG.collapsedWidth - 2}px;
          align-items: center;

          border: 0;
          border-radius: 11px;
          outline: 0;
          appearance: none;
          -webkit-appearance: none;
          background: transparent;
          color: inherit;
          font: inherit;
          text-align: start;

          cursor: pointer;

          animation: nav-row-in 230ms cubic-bezier(.2,.8,.2,1) backwards;
          animation-delay: var(--entry-delay, 0ms);

          transition:
            padding-left ${CONFIG.animationMs}ms cubic-bezier(.2,.8,.2,1),
            background-color 110ms ease,
            transform 120ms cubic-bezier(.2,.8,.2,1);
        }

        #shell:hover .nav-row,
        #shell:focus-within .nav-row {
          padding-left: 9px;
        }

        .nav-row:hover,
        .nav-row.row-hover {
          background: color-mix(in srgb, CanvasText 9%, transparent);
          transform: translateX(-2px);
        }

        .nav-row.row-active {
          background: color-mix(in srgb, AccentColor 8%, CanvasText 3%);
        }

        .nav-row:focus-visible {
          box-shadow: inset 0 0 0 2px color-mix(in srgb, AccentColor 55%, transparent);
        }

        .nav-title-wrap {
          min-width: 0;
          display: grid;
          grid-template-columns: 34px minmax(0, 1fr);
          align-items: center;

          opacity: 0;
          visibility: hidden;
          transform: translateX(10px);

          transition:
            opacity 120ms ease,
            transform ${CONFIG.animationMs}ms cubic-bezier(.2,.8,.2,1),
            visibility 120ms step-end;
        }

        #shell:hover .nav-title-wrap,
        #shell:focus-within .nav-title-wrap {
          opacity: 1;
          visibility: visible;
          transform: translateX(0);

          transition:
            opacity 120ms ease 35ms,
            transform ${CONFIG.animationMs}ms cubic-bezier(.2,.8,.2,1),
            visibility 0s;
        }

        #shell:not(:hover):not(:focus-within) .nav-title-wrap {
          min-width: 0;
          overflow: hidden;
          pointer-events: none;
        }

        .nav-num {
          padding-right: 9px;
          text-align: right;
          font-size: 10px;
          font-variant-numeric: tabular-nums;
          letter-spacing: .04em;
          opacity: .36;
        }

        .nav-row.row-active .nav-num,
        .nav-row.row-hover .nav-num { opacity: .72; }

        .nav-title {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 13px;
          line-height: 1.35;
        }

        .nav-line-cell {
          position: relative;
          align-self: stretch;
        }

        .nav-line {
          position: absolute;
          right: 10px;
          top: 50%;

          width: ${CONFIG.normalWidth}px;
          height: 2px;
          border-radius: 999px;
          background: color-mix(in srgb, CanvasText 29%, transparent);
          opacity: .72;

          transform: translateY(-50%);
          transform-origin: right center;

          transition:
            width ${CONFIG.animationMs}ms cubic-bezier(.2,.8,.2,1),
            height ${CONFIG.animationMs}ms ease,
            opacity ${CONFIG.animationMs}ms ease,
            background-color ${CONFIG.animationMs}ms ease,
            box-shadow ${CONFIG.animationMs}ms ease;
        }

        .nav-row.near-2 .nav-line {
          width: ${CONFIG.near2Width}px;
          opacity: .78;
        }

        .nav-row.near-1 .nav-line {
          width: ${CONFIG.near1Width}px;
          opacity: .86;
        }

        .nav-row.row-active .nav-line {
          width: ${CONFIG.activeWidth}px;
          height: 3px;
          opacity: 1;
          background: color-mix(in srgb, AccentColor 64%, CanvasText 36%);
          box-shadow: 0 0 10px color-mix(in srgb, AccentColor 20%, transparent);
        }

        .nav-row.row-hover .nav-line,
        .nav-row:focus-visible .nav-line {
          width: ${CONFIG.hoverWidth}px;
          height: 3px;
          opacity: 1;
          background: color-mix(in srgb, CanvasText 96%, transparent);
          box-shadow: none;
        }

        @keyframes nav-row-in {
          from {
            opacity: 0;
            transform: translateX(6px);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          #shell,
          #header,
          .nav-row,
          .nav-title-wrap,
          .nav-line {
            transition-duration: 0ms !important;
            animation: none !important;
          }
        }

        @media (forced-colors: active) {
          #shell:hover,
          #shell:focus-within { border-color: CanvasText; }
          .nav-row:focus-visible { outline: 2px solid Highlight; }
          .nav-line { background: CanvasText; }
        }
      </style>

      <section id="shell" data-empty="true" aria-label="ChatGPT 会话导航">
        <header id="header">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true"></span>
            <span class="brand-title">会话索引</span>
          </div>
          <div class="meta">
            <span id="count">0 个提问</span>
            <kbd>Alt ↑↓</kbd>
          </div>
        </header>
        <div id="body"></div>
      </section>
    `;

    (document.body || document.documentElement).appendChild(host);

    state.host = host;
    state.shadow = shadow;
    state.shell = shadow.getElementById('shell');
    state.body = shadow.getElementById('body');
    state.count = shadow.getElementById('count');

    state.shell.addEventListener('pointerleave', () => {
      state.hoverIndex = -1;
      updateVisualState(false);
    });
  }

  // =========================================================
  // 6. 严格一对一渲染
  // =========================================================

  function render() {
    if (!state.shell || !state.body) return;

    const n = state.items.length;
    state.shell.dataset.empty = String(n === 0);
    state.body.replaceChildren();

    state.count.textContent = `${n} 个提问`;

    if (!n) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '暂未检测到用户提问';
      state.body.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();

    state.items.forEach((item, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'nav-row';
      row.dataset.index = String(index);
      row.title = item.fullText;
      row.setAttribute('aria-label', `${index + 1}. ${item.title}`);
      row.style.setProperty('--entry-delay', `${Math.min(index, 12) * 12}ms`);

      const titleWrap = document.createElement('span');
      titleWrap.className = 'nav-title-wrap';

      const num = document.createElement('span');
      num.className = 'nav-num';
      num.textContent = String(index + 1).padStart(2, '0');

      const title = document.createElement('span');
      title.className = 'nav-title';
      title.textContent = item.title;

      titleWrap.append(num, title);

      const lineCell = document.createElement('span');
      lineCell.className = 'nav-line-cell';

      // 每条提问始终只有这一根真实线段。
      const line = document.createElement('span');
      line.className = 'nav-line';
      lineCell.appendChild(line);

      row.append(titleWrap, lineCell);

      row.addEventListener('pointerenter', () => {
        state.hoverIndex = index;
        updateVisualState(true);
      });

      row.addEventListener('click', () => scrollToItem(index));

      fragment.appendChild(row);
    });

    state.body.appendChild(fragment);

    assertInvariant();
    updateVisualState(false);
  }

  function assertInvariant() {
    const itemCount = state.items.length;
    const rowCount = state.shadow.querySelectorAll('.nav-row').length;
    const lineCount = state.shadow.querySelectorAll('.nav-row > .nav-line-cell > .nav-line').length;
    const titleCount = state.shadow.querySelectorAll('.nav-row > .nav-title-wrap > .nav-title').length;

    const ok =
      itemCount === rowCount &&
      itemCount === lineCount &&
      itemCount === titleCount;

    if (!ok) {
      console.error(`[ChatGPT Navigator v${VERSION}] 渲染不变量失败`, {
        itemCount,
        lineCount,
        rowCount,
        titleCount
      });
    } else {
      console.debug(`[ChatGPT Navigator v${VERSION}] invariant OK`, {
        itemCount,
        lineCount,
        rowCount,
        titleCount
      });
    }
  }

  function updateVisualState(scrollHoveredRow = false) {
    if (!state.shadow) return;

    state.shadow.querySelectorAll('.nav-row').forEach(row => {
      const i = Number(row.dataset.index);
      const distance = state.hoverIndex >= 0
        ? Math.abs(i - state.hoverIndex)
        : Infinity;

      row.classList.toggle('row-active', i === state.activeIndex);
      row.classList.toggle('row-hover', i === state.hoverIndex);
      row.classList.toggle('near-1', distance === 1);
      row.classList.toggle('near-2', distance === 2);
    });

    if (scrollHoveredRow && state.hoverIndex >= 0) {
      requestAnimationFrame(() => {
        state.shadow
          .querySelector(`.nav-row[data-index="${state.hoverIndex}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      });
    }
  }

  // =========================================================
  // 7. 跳转 / 当前阅读位置
  // =========================================================

  function getNativeNavigationControl(item) {
    const navigationId = item?.target?.getAttribute?.('data-content-search-unit-key');
    if (!navigationId) return null;

    return [...document.querySelectorAll('[data-thread-user-message-navigation-item-id]')]
      .find(control =>
        control.getAttribute('data-thread-user-message-navigation-item-id') === navigationId
      ) || null;
  }

  function alignItemToStart(item, behavior = 'auto') {
    if (!item?.target?.isConnected) return;

    item.target.scrollIntoView({
      behavior,
      block: 'start',
      inline: 'nearest',
    });
  }

  function scrollToItem(index) {
    const item = state.items[index];

    if (!item?.target?.isConnected) {
      scheduleScan();
      return;
    }

    clearTimeout(state.jumpCorrectionTimer);

    const nativeControl = getNativeNavigationControl(item);
    if (nativeControl?.isConnected) {
      nativeControl.click();
    } else {
      alignItemToStart(item, CONFIG.smoothScroll ? 'smooth' : 'auto');
    }

    // 平滑滚动期间内容高度可能继续变化；结束后用用户消息锚点再校准一次。
    state.jumpCorrectionTimer = setTimeout(() => {
      if (!item.target?.isConnected) return;

      const viewport = getViewportMetrics();
      const rect = item.target.getBoundingClientRect();
      const scrollMarginTop = Number.parseFloat(getComputedStyle(item.target).scrollMarginTop) || 0;
      const expectedTop = viewport.top + scrollMarginTop;

      if (Math.abs(rect.top - expectedTop) > 6) {
        alignItemToStart(item, 'auto');
      }
    }, CONFIG.jumpCorrectionMs);

    setActive(index);
  }

  function navigateRelative(delta) {
    if (!state.items.length) return;

    let index = state.activeIndex;
    if (index < 0) index = 0;

    index = Math.max(
      0,
      Math.min(state.items.length - 1, index + delta)
    );

    scrollToItem(index);
  }

  function updateActiveFromViewport() {
    if (!state.items.length) {
      setActive(-1);
      return;
    }

    const viewport = getViewportMetrics();
    const anchorY = viewport.top + viewport.height * 0.32;

    let bestIndex = 0;
    let bestDistance = Infinity;

    state.items.forEach((item, index) => {
      if (!item.target?.isConnected) return;

      const rect = item.target.getBoundingClientRect();
      const y = rect.top + Math.min(rect.height * 0.22, 20);
      const distance = Math.abs(y - anchorY);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    setActive(bestIndex);
  }

  function setActive(index) {
    if (state.activeIndex === index) return;
    state.activeIndex = index;
    updateVisualState(false);
  }

  // =========================================================
  // 8. 扫描 / SPA
  // =========================================================

  function scanMessages() {
    if (state.destroyed) return;

    let uiRecreated = false;
    if (!state.host?.isConnected) {
      createUI();
      uiRecreated = true;
    }

    const conversationRoot = getConversationRoot();
    const nodes = getUserMessageNodes(conversationRoot);
    const seenTargets = new Set();
    const nextItems = [];

    for (const node of nodes) {
      const target = getScrollTarget(node);
      if (!target || seenTargets.has(target)) continue;

      const fullText = extractMessageText(node);
      if (!fullText) continue;

      seenTargets.add(target);

      nextItems.push({
        node,
        target,
        fullText,
        title: truncate(fullText),
      });
    }

    const changed =
      nextItems.length !== state.items.length ||
      nextItems.some((item, i) =>
        item.target !== state.items[i]?.target ||
        item.fullText !== state.items[i]?.fullText
      );

    state.conversationRoot = conversationRoot;
    state.scrollRoot = findScrollRoot(nextItems[0]?.target || conversationRoot);
    state.items = nextItems;

    if (changed || uiRecreated) render();
    updateActiveFromViewport();
  }

  function scheduleScan(delay = CONFIG.scanDebounceMs) {
    if (state.destroyed) return;
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(scanMessages, delay);
  }

  function observeDOM() {
    state.mutationObserver?.disconnect();

    state.mutationObserver = new MutationObserver(() => {
      scheduleScan();
    });

    state.mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'data-message-author-role',
        'data-message-role',
        'data-user-message-bubble',
        'data-turn-key',
        'data-content-search-turn-key',
        'data-conversation-id',
        'data-above-composer-conversation-id',
        'data-testid',
        'data-thread-find-target',
        'data-app-action-sidebar-thread-id',
        'aria-current',
        'aria-selected',
        'data-state',
      ],
    });
  }

  function onAnyScroll() {
    if (state.destroyed) return;
    if (state.scrollRAF) return;

    state.scrollRAF = requestAnimationFrame(() => {
      state.scrollRAF = null;
      updateActiveFromViewport();
    });
  }

  function onResize() {
    render();
    onAnyScroll();
  }

  function onVisibilityChange() {
    if (!document.hidden) scheduleScan(0);
  }

  function onKeyDown(event) {
    const target = event.target;
    const tag = target?.tagName?.toLowerCase();

    const editing =
      tag === 'input' ||
      tag === 'textarea' ||
      target?.isContentEditable;

    if (editing) return;

    if (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.key === 'ArrowUp'
    ) {
      event.preventDefault();
      navigateRelative(-1);
    }

    if (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.key === 'ArrowDown'
    ) {
      event.preventDefault();
      navigateRelative(1);
    }
  }

  function watchRoute() {
    state.currentRouteKey = getRouteKey();
    clearInterval(state.routeTimer);

    state.routeTimer = setInterval(() => {
      if (state.destroyed) return;

      if (!state.host?.isConnected) {
        createUI();
        render();
      }

      const nextRouteKey = getRouteKey();
      if (nextRouteKey === state.currentRouteKey) return;

      state.currentRouteKey = nextRouteKey;
      state.items = [];
      state.activeIndex = -1;
      state.hoverIndex = -1;

      render();

      scheduleScan(0);
      clearTimeout(state.lateScanTimer);
      state.lateScanTimer = setTimeout(() => scheduleScan(0), 450);
    }, CONFIG.routePollMs);
  }

  // =========================================================
  // 9. 初始化
  // =========================================================

  function init() {
    if (state.destroyed || state.initialized) return;
    state.initialized = true;

    createUI();

    scanMessages();
    observeDOM();
    watchRoute();

    window.addEventListener('scroll', onAnyScroll, {
      passive: true,
      capture: true,
    });

    window.addEventListener('resize', onResize, { passive: true });

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('visibilitychange', onVisibilityChange);

    console.info(`[ChatGPT Navigator v${VERSION}] initialized`);
  }

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;

    clearTimeout(state.scanTimer);
    clearTimeout(state.lateScanTimer);
    clearTimeout(state.jumpCorrectionTimer);
    clearInterval(state.routeTimer);
    if (state.scrollRAF) cancelAnimationFrame(state.scrollRAF);

    state.mutationObserver?.disconnect();
    window.removeEventListener('scroll', onAnyScroll, true);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (state.domReadyHandler) {
      document.removeEventListener('DOMContentLoaded', state.domReadyHandler);
    }

    state.host?.remove();
    document.getElementById(LOCK_ID)?.remove();
    document.getElementById(LEGACY_STYLE_ID)?.remove();

    if (window[INSTALL_KEY] === api) {
      delete window[INSTALL_KEY];
    }

    console.info(`[ChatGPT Navigator v${VERSION}] destroyed`);
  }

  const api = {
    version: VERSION,
    rescan: () => scheduleScan(0),
    destroy,
  };

  window[INSTALL_KEY] = api;

  if (document.readyState === 'loading') {
    state.domReadyHandler = init;
    document.addEventListener('DOMContentLoaded', state.domReadyHandler, { once: true });
  } else {
    init();
  }
})();
