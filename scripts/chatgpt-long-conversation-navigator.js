// ==UserScript==
// @name         ChatGPT 长对话双侧导航与预览（Codex++）
// @namespace    https://github.com/kdazhy
// @version      6.4.0
// @description  为 ChatGPT Windows 桌面端提供完整会话提问索引、聊天/任务回答章节索引、精确跳转和动态布局避让。
// @author       kdazhy
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '6.4.0';
  const INSTALL_KEY = '__codexPlusChatConversationNavigator';
  const LOCK_ID = 'cgpt-codex-navigator-lock';
  const HOST_ID = 'cgpt-codex-navigator-v6-host';
  const LEGACY_STYLE_ID = 'cgpt-codex-navigator-v6-legacy-shield';

  const CONFIG = {
    right: 10,
    collapsedWidth: 54,
    expandedWidth: 430,
    chapterCollapsedWidth: 52,
    chapterExpandedWidth: 350,
    chapterGapFromAnswer: 16,
    chapterObstructionGap: 8,
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
    chapterTitleMaxChars: 70,
    fallbackChapterMinChars: 700,
    fallbackChapterMinHeight: 720,
    fallbackChapterMaxChars: 96,
    fallbackChapterLabelMaxChars: 44,
    fallbackChapterMinGapPx: 28,
    fallbackChapterMaxCount: 12,
    chapterMinVisibleCount: 3,
    chapterMinAnswerChars: 700,
    chapterMinAnswerHeight: 720,
    readingAnchorRatio: 0.30,
    scanDebounceMs: 180,
    scanIdleTimeoutMs: 260,
    routePollMs: 900,
    jumpCorrectionMs: 650,
    layoutPollMs: 120,
    layoutSettleMs: 720,
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
    chapterShell: null,
    chapterBody: null,
    chapterCount: null,
    chapterContext: null,

    items: [],
    previewCache: new Map(),
    activeIndex: -1,
    hoverIndex: -1,
    chapters: [],
    chapterRows: [],
    activeChapterIndex: -1,
    hoverChapterIndex: -1,
    chapterVisualActiveIndex: -2,
    chapterVisualHoverIndex: -2,
    chapterMetrics: null,
    viewportMetrics: null,
    viewportMetricsDirty: true,
    conversationRoot: null,
    scrollRoot: null,

    currentRouteKey: '',
    destroyed: false,
    scanCount: 0,
    scanTimer: null,
    scanIdleHandle: null,
    lateScanTimer: null,
    navigationScanTimer: null,
    jumpCorrectionTimer: null,
    scrollRAF: null,
    mutationObserver: null,
    resizeObserver: null,
    layoutTimer: null,
    layoutBurstUntil: 0,
    lastChapterRight: null,
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

  // “任务”消息通常有独立 user anchor；“聊天”fallback turn 会把问答放在同一 turn。
  // 回答关联必须使用更窄的用户单元，不能复用可能包住整轮回答的跳转目标。
  function getMessageBoundary(messageNode) {
    return (
      messageNode.closest('[data-local-conversation-user-anchor]') ||
      messageNode.closest('[data-content-search-unit-key]') ||
      messageNode.closest('[data-testid="user-message"]') ||
      messageNode.closest('[data-message-id]') ||
      messageNode
    );
  }

  function getNavigationId(messageNode, boundary, target) {
    for (const node of [boundary, messageNode, target]) {
      const id = node?.getAttribute?.('data-content-search-unit-key');
      if (id) return id;
    }
    return '';
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

  function isNodeBetween(node, start, end) {
    if (!node?.isConnected || !start?.isConnected || start.contains(node)) return false;

    const afterStart = Boolean(
      start.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING
    );
    if (!afterStart) return false;

    return !end || Boolean(
      node.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING
    );
  }

  function findAssistantRoot(conversationRoot, start, end) {
    if (!conversationRoot || !start) return null;

    const selectorGroups = [
      '[data-markdown-text-style="assistant-message"]',
      '[data-message-author-role="assistant"] .markdown, [data-message-author-role="assistant"] [class*="markdown"]',
      '.markdown, [class*="MarkdownRoot"]',
    ];

    for (const selector of selectorGroups) {
      const candidate = [...conversationRoot.querySelectorAll(selector)]
        .find(node =>
          !node.closest('[data-user-message-bubble], [data-local-conversation-user-anchor]') &&
          isNodeBetween(node, start, end)
        );
      if (candidate) return candidate;
    }

    return [...conversationRoot.querySelectorAll('[data-content-search-unit-key]')]
      .find(unit => {
        if (!isNodeBetween(unit, start, end)) return false;
        return [...unit.querySelectorAll('h4.sr-only')]
          .some(label => /ChatGPT\s*说|assistant/i.test(label.textContent || ''));
      }) || null;
  }

  function getHeadingLevel(heading) {
    const match = heading?.tagName?.match(/^H([1-6])$/i);
    return match ? Number(match[1]) : 2;
  }

  function isVisibleChapterTarget(node) {
    if (
      !node?.isConnected ||
      node.matches?.('.sr-only, [aria-hidden="true"]') ||
      node.closest?.('[data-user-message-bubble], [data-local-conversation-user-anchor]')
    ) {
      return false;
    }

    const rect = node.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  }

  function isNumberedChapterTitle(text) {
    return /^(?:第\s*[0-9一二三四五六七八九十百千万]+\s*(?:章|节|部分|步|阶段)(?=$|[\s:：.。、-])|[一二三四五六七八九十百千万]+[、.．。]\s*|[（(]\s*[一二三四五六七八九十百千万0-9]+\s*[）)]\s*|[0-9]{1,3}\s*[.)、．:：]\s*)/.test(text);
  }

  function isStandaloneEmphasis(node, text) {
    const children = [...(node.children || [])].filter(child => !child.matches('br'));
    const emphasis = children.filter(child => child.matches('strong, b, em, i, mark'));
    if (children.length !== 1 || emphasis.length !== 1) return false;

    const emphasisText = oneLine(emphasis[0].innerText || emphasis[0].textContent || '');
    return Boolean(emphasisText) && emphasisText === text;
  }

  function isStandaloneChapterLabel(text) {
    return (
      text.length <= CONFIG.fallbackChapterLabelMaxChars &&
      /[:：]$/.test(text) &&
      !/[。！？.!?]/.test(text.slice(0, -1)) &&
      !/[，,]/.test(text.slice(0, -1))
    );
  }

  function isFallbackChapterCandidate(node) {
    if (!isVisibleChapterTarget(node)) return false;

    const tagName = node.tagName?.toUpperCase();
    if (
      !['P', 'DIV'].includes(tagName) ||
      node.matches('blockquote, ul, ol, pre, table, code') ||
      node.closest('blockquote, ul, ol, pre, table, code')
    ) {
      return false;
    }

    const text = oneLine(node.innerText || node.textContent || '');
    if (
      text.length < 3 ||
      text.length > CONFIG.fallbackChapterMaxChars
    ) {
      return false;
    }

    return (
      isNumberedChapterTitle(text) ||
      isStandaloneEmphasis(node, text) ||
      isStandaloneChapterLabel(text)
    );
  }

  function toChapter(target, level = 2, synthetic = false) {
    const fullText = oneLine(target.innerText || target.textContent || '');
    return {
      heading: target,
      level,
      synthetic,
      fullText,
      title: truncate(fullText, CONFIG.chapterTitleMaxChars),
    };
  }

  function buildFallbackChapters(root) {
    const rootRect = root.getBoundingClientRect();
    const rootText = oneLine(root.innerText || root.textContent || '');
    if (
      rootText.length < CONFIG.fallbackChapterMinChars &&
      rootRect.height < CONFIG.fallbackChapterMinHeight
    ) {
      return [];
    }

    const candidates = [...root.querySelectorAll([
      ':scope > p',
      ':scope > div',
    ].join(','))].filter(isFallbackChapterCandidate);

    const chapters = [];
    let lastTop = -Infinity;
    for (const candidate of candidates) {
      const top = candidate.getBoundingClientRect().top;
      if (chapters.length && top - lastTop < CONFIG.fallbackChapterMinGapPx) continue;
      chapters.push(toChapter(candidate, chapters.length ? 3 : 2, true));
      lastTop = top;
      if (chapters.length >= CONFIG.fallbackChapterMaxCount) break;
    }

    return chapters.filter(chapter => chapter.fullText);
  }

  function buildChapterModel(item) {
    const root = item?.assistantRoot;
    if (!root?.isConnected) return [];

    const rootText = oneLine(root.innerText || root.textContent || '');
    const rootRect = root.getBoundingClientRect();
    if (
      rootText.length < CONFIG.chapterMinAnswerChars &&
      rootRect.height < CONFIG.chapterMinAnswerHeight
    ) {
      return [];
    }

    const semanticChapters = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .filter(isVisibleChapterTarget)
      .map(heading => toChapter(heading, getHeadingLevel(heading)))
      .filter(chapter => chapter.fullText);

    if (semanticChapters.length) {
      return semanticChapters.length >= CONFIG.chapterMinVisibleCount
        ? semanticChapters
        : [];
    }

    const fallbackChapters = buildFallbackChapters(root);
    return fallbackChapters.length >= CONFIG.chapterMinVisibleCount
      ? fallbackChapters
      : [];
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
    if (state.viewportMetrics && !state.viewportMetricsDirty) {
      return state.viewportMetrics;
    }

    const root = state.scrollRoot;
    if (!root || root === document.body || root === document.documentElement || root === document.scrollingElement) {
      state.viewportMetrics = {
        top: 0,
        bottom: window.innerHeight,
        height: window.innerHeight,
      };
      state.viewportMetricsDirty = false;
      return state.viewportMetrics;
    }

    const rect = root.getBoundingClientRect();
    const top = Math.max(0, rect.top);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    state.viewportMetrics = {
      top,
      bottom,
      height: Math.max(1, bottom - top),
    };
    state.viewportMetricsDirty = false;
    return state.viewportMetrics;
  }

  function getScrollOffset(root = state.scrollRoot) {
    if (!root || root === document.body || root === document.documentElement || root === document.scrollingElement) {
      return document.scrollingElement?.scrollTop || window.scrollY || 0;
    }
    return root.scrollTop || 0;
  }

  function captureChapterMetrics() {
    if (!state.chapters.length || !state.scrollRoot) {
      state.chapterMetrics = null;
      return;
    }

    const tops = state.chapters.map(chapter => {
      const heading = chapter.heading;
      return heading?.isConnected
        ? heading.getBoundingClientRect().top
        : null;
    });

    state.chapterMetrics = {
      root: state.scrollRoot,
      scrollTop: getScrollOffset(),
      tops,
    };
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

        /* v6.2：右侧会话 + 左侧当前回答，共用单行精密导航语言。 */
        .nav-shell {
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
            right ${CONFIG.animationMs}ms cubic-bezier(.2,.8,.2,1),
            background-color ${CONFIG.animationMs}ms ease,
            border-color ${CONFIG.animationMs}ms ease,
            box-shadow ${CONFIG.animationMs}ms ease;
        }

        .nav-shell[data-empty="true"],
        .nav-shell[data-constrained="true"] {
          display: none;
        }

        .nav-shell:hover,
        .nav-shell:focus-within {
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

        .nav-header {
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

        .nav-shell:hover .nav-header,
        .nav-shell:focus-within .nav-header {
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

        .nav-body {
          min-height: 0;
          padding: 0;
          overflow-x: hidden;
          overflow-y: auto;
          contain: layout paint;
          will-change: scroll-position;
          overscroll-behavior: contain;
          scrollbar-width: none;
        }

        .nav-body::-webkit-scrollbar { width: 0; height: 0; }

        .nav-shell:hover .nav-body,
        .nav-shell:focus-within .nav-body {
          padding: 7px;
          scrollbar-width: thin;
          scrollbar-color: color-mix(in srgb, CanvasText 18%, transparent) transparent;
        }

        .nav-shell:hover .nav-body::-webkit-scrollbar,
        .nav-shell:focus-within .nav-body::-webkit-scrollbar { width: 6px; }

        .nav-shell:hover .nav-body::-webkit-scrollbar-thumb,
        .nav-shell:focus-within .nav-body::-webkit-scrollbar-thumb {
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

        .nav-shell:hover .nav-row,
        .nav-shell:focus-within .nav-row {
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

        .nav-shell:hover .nav-title-wrap,
        .nav-shell:focus-within .nav-title-wrap {
          opacity: 1;
          visibility: visible;
          transform: translateX(0);

          transition:
            opacity 120ms ease 35ms,
            transform ${CONFIG.animationMs}ms cubic-bezier(.2,.8,.2,1),
            visibility 0s;
        }

        .nav-shell:not(:hover):not(:focus-within) .nav-title-wrap {
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

        #body .nav-row[data-loaded="false"] .nav-title,
        #body .nav-row[data-preview-known="false"] .nav-num {
          opacity: .48;
        }

        #body .nav-row[data-loaded="false"]:not(.row-active):not(.row-hover) .nav-line {
          width: 5px;
          opacity: .42;
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

        #chapter-shell {
          --chapter-available-width: ${CONFIG.chapterExpandedWidth}px;
          container-type: inline-size;
          width: ${CONFIG.chapterCollapsedWidth}px;
          max-width: var(--chapter-available-width);
          right: calc(100vw - ${CONFIG.chapterCollapsedWidth + 8}px);
          transform-origin: right center;
        }

        #chapter-shell:hover,
        #chapter-shell:focus-within {
          width: min(${CONFIG.chapterExpandedWidth}px, var(--chapter-available-width));
        }

        #chapter-shell .nav-row {
          grid-template-columns: minmax(0, 1fr) ${CONFIG.chapterCollapsedWidth - 2}px;
        }

        #chapter-shell .nav-line { right: 8px; }
        #chapter-shell .nav-title-wrap { grid-template-columns: 31px minmax(0, 1fr); }

        #chapter-context {
          max-width: 188px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 10px;
          opacity: .45;
        }

        #chapter-shell .brand-title { flex: 0 0 auto; }

        @container (max-width: 310px) {
          #chapter-context { display: none; }
        }

        #chapter-shell .nav-title.level-1,
        #chapter-shell .nav-title.level-2 { font-weight: 640; }
        #chapter-shell .nav-title.level-3 { padding-left: 9px; }
        #chapter-shell .nav-title.level-4 { padding-left: 18px; opacity: .88; }
        #chapter-shell .nav-title.level-5,
        #chapter-shell .nav-title.level-6 { padding-left: 26px; opacity: .78; }

        #chapter-shell .nav-row[data-level="1"]:not(.row-active):not(.row-hover) .nav-line { width: 15px; }
        #chapter-shell .nav-row[data-level="2"]:not(.row-active):not(.row-hover) .nav-line { width: 11px; }
        #chapter-shell .nav-row[data-level="3"]:not(.row-active):not(.row-hover) .nav-line { width: 8px; }
        #chapter-shell .nav-row[data-level="4"]:not(.row-active):not(.row-hover) .nav-line,
        #chapter-shell .nav-row[data-level="5"]:not(.row-active):not(.row-hover) .nav-line,
        #chapter-shell .nav-row[data-level="6"]:not(.row-active):not(.row-hover) .nav-line { width: 6px; }

        @keyframes nav-row-in {
          from {
            opacity: 0;
            transform: translateX(6px);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .nav-shell,
          .nav-header,
          .nav-row,
          .nav-title-wrap,
          .nav-line {
            transition-duration: 0ms !important;
            animation: none !important;
          }
        }

        @media (forced-colors: active) {
          .nav-shell:hover,
          .nav-shell:focus-within { border-color: CanvasText; }
          .nav-row:focus-visible { outline: 2px solid Highlight; }
          .nav-line { background: CanvasText; }
        }
      </style>

      <section id="chapter-shell" class="nav-shell" data-empty="true" data-constrained="false" aria-label="当前回答章节导航">
        <header id="chapter-header" class="nav-header">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true"></span>
            <span class="brand-title">回答章节</span>
            <span id="chapter-context"></span>
          </div>
          <div class="meta">
            <span id="chapter-count">0 章</span>
          </div>
        </header>
        <div id="chapter-body" class="nav-body"></div>
      </section>

      <section id="shell" class="nav-shell" data-empty="true" aria-label="ChatGPT 会话导航">
        <header id="header" class="nav-header">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true"></span>
            <span class="brand-title">会话索引</span>
          </div>
          <div class="meta">
            <span id="count">0 个提问</span>
            <kbd>Alt ↑↓</kbd>
          </div>
        </header>
        <div id="body" class="nav-body"></div>
      </section>
    `;

    (document.body || document.documentElement).appendChild(host);

    state.host = host;
    state.shadow = shadow;
    state.shell = shadow.getElementById('shell');
    state.body = shadow.getElementById('body');
    state.count = shadow.getElementById('count');
    state.chapterShell = shadow.getElementById('chapter-shell');
    state.chapterBody = shadow.getElementById('chapter-body');
    state.chapterCount = shadow.getElementById('chapter-count');
    state.chapterContext = shadow.getElementById('chapter-context');

    state.shell.addEventListener('pointerleave', () => {
      state.hoverIndex = -1;
      updateVisualState(false);
    });

    state.chapterShell.addEventListener('pointerleave', () => {
      state.hoverChapterIndex = -1;
      updateChapterVisualState(false);
    });
  }

  // =========================================================
  // 6. 严格一对一渲染
  // =========================================================

  function getNativeNavigationEntries() {
    const seen = new Set();
    return [...document.querySelectorAll('[data-thread-user-message-navigation-item-id]')]
      .map((control, index) => ({
        control,
        index,
        navigationId: control.getAttribute('data-thread-user-message-navigation-item-id') || '',
      }))
      .filter(entry => {
        if (!entry.navigationId || seen.has(entry.navigationId)) return false;
        seen.add(entry.navigationId);
        return true;
      });
  }

  function mergeWithNativeNavigation(loadedItems) {
    const nativeEntries = getNativeNavigationEntries();
    if (!nativeEntries.length) return loadedItems;

    const loadedById = new Map();
    for (const item of loadedItems) {
      if (!item.navigationId) continue;
      loadedById.set(item.navigationId, item);
      state.previewCache.set(item.navigationId, {
        fullText: item.fullText,
        title: item.title,
      });
    }

    const used = new Set();
    const merged = nativeEntries.map((entry, index) => {
      const loaded = loadedById.get(entry.navigationId);
      if (loaded) {
        used.add(loaded);
        return {
          ...loaded,
          nativeControl: entry.control,
          loaded: true,
          previewKnown: true,
        };
      }

      const cached = state.previewCache.get(entry.navigationId);
      const placeholder = `第 ${index + 1} 个提问（点击载入预览）`;
      return {
        node: null,
        target: null,
        boundary: null,
        assistantRoot: null,
        navigationId: entry.navigationId,
        nativeControl: entry.control,
        loaded: false,
        previewKnown: Boolean(cached),
        fullText: cached?.fullText || placeholder,
        title: cached?.title || placeholder,
      };
    });

    // 旧网页结构或 fallback chat 可能没有对应原生控件，仍保留已识别的真实消息。
    for (const item of loadedItems) {
      if (!used.has(item)) merged.push(item);
    }

    return merged;
  }

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
      row.dataset.navigationId = item.navigationId || '';
      row.dataset.loaded = String(item.loaded !== false);
      row.dataset.previewKnown = String(item.previewKnown !== false);
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
    const rowCount = state.shadow.querySelectorAll('#body .nav-row').length;
    const lineCount = state.shadow.querySelectorAll('#body .nav-row > .nav-line-cell > .nav-line').length;
    const titleCount = state.shadow.querySelectorAll('#body .nav-row > .nav-title-wrap > .nav-title').length;

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

    state.shadow.querySelectorAll('#body .nav-row').forEach(row => {
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
          .querySelector(`#body .nav-row[data-index="${state.hoverIndex}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      });
    }
  }

  function getReadingAnchorY() {
    const viewport = getViewportMetrics();
    return viewport.top + viewport.height * CONFIG.readingAnchorRatio;
  }

  function getActiveChapterIndexFromViewport() {
    if (!state.chapters.length) return -1;

    const anchorY = getReadingAnchorY();
    const metrics = state.chapterMetrics;
    if (
      !metrics ||
      metrics.root !== state.scrollRoot ||
      metrics.tops.length !== state.chapters.length
    ) {
      captureChapterMetrics();
    }

    const chapterMetrics = state.chapterMetrics;
    const scrollDelta = chapterMetrics
      ? getScrollOffset() - chapterMetrics.scrollTop
      : 0;
    let active = 0;

    for (let index = 0; index < state.chapters.length; index += 1) {
      const top = chapterMetrics?.tops[index];
      if (top == null) continue;
      if (top - scrollDelta <= anchorY) active = index;
      else break;
    }

    return active;
  }

  function refreshChapters(forceRender = false) {
    const item = state.items[state.activeIndex];
    const nextChapters = buildChapterModel(item);
    const changed =
      nextChapters.length !== state.chapters.length ||
      nextChapters.some((chapter, index) =>
        chapter.heading !== state.chapters[index]?.heading ||
        chapter.level !== state.chapters[index]?.level ||
        chapter.fullText !== state.chapters[index]?.fullText
      );

    state.chapters = nextChapters;
    state.chapterMetrics = null;
    state.activeChapterIndex = getActiveChapterIndexFromViewport();

    if (changed || forceRender) renderChapters();
    else updateChapterVisualState(false);

    captureChapterMetrics();
    updateChapterPosition();
  }

  function renderChapters() {
    if (!state.chapterShell || !state.chapterBody) return;

    const item = state.items[state.activeIndex];
    const count = state.chapters.length;
    state.chapterShell.dataset.empty = String(count === 0);
    state.chapterRows = [];
    state.chapterVisualActiveIndex = -2;
    state.chapterVisualHoverIndex = -2;
    state.chapterBody.replaceChildren();
    state.chapterCount.textContent = `${count} 章`;
    state.chapterContext.textContent = item ? truncate(item.fullText, 30) : '';

    if (!count) {
      state.chapterMetrics = null;
      return;
    }

    const fragment = document.createDocumentFragment();
    state.chapters.forEach((chapter, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'nav-row';
      row.dataset.index = String(index);
      row.dataset.level = String(chapter.level);
      row.title = chapter.fullText;
      row.setAttribute('aria-label', `${index + 1}. ${chapter.title}`);
      row.style.setProperty('--entry-delay', `${Math.min(index, 12) * 12}ms`);

      const titleWrap = document.createElement('span');
      titleWrap.className = 'nav-title-wrap';

      const num = document.createElement('span');
      num.className = 'nav-num';
      num.textContent = String(index + 1).padStart(2, '0');

      const title = document.createElement('span');
      title.className = `nav-title level-${chapter.level}`;
      title.textContent = chapter.title;
      titleWrap.append(num, title);

      const lineCell = document.createElement('span');
      lineCell.className = 'nav-line-cell';
      const line = document.createElement('span');
      line.className = 'nav-line';
      lineCell.appendChild(line);
      row.append(titleWrap, lineCell);

      row.addEventListener('pointerenter', () => {
        state.hoverChapterIndex = index;
        updateChapterVisualState(true);
      });
      row.addEventListener('click', () => scrollToChapter(index));
      state.chapterRows.push(row);
      fragment.appendChild(row);
    });

    state.chapterBody.appendChild(fragment);
    updateChapterVisualState(false);
  }

  function updateChapterVisualState(scrollHoveredRow = false) {
    if (!state.shadow) return;

    const previousActive = state.chapterVisualActiveIndex;
    const previousHover = state.chapterVisualHoverIndex;
    const affected = new Set([
      previousActive,
      state.activeChapterIndex,
      previousHover,
      state.hoverChapterIndex,
    ]);

    for (const hoverIndex of [previousHover, state.hoverChapterIndex]) {
      if (hoverIndex < 0) continue;
      affected.add(hoverIndex - 2);
      affected.add(hoverIndex - 1);
      affected.add(hoverIndex + 1);
      affected.add(hoverIndex + 2);
    }

    for (const index of affected) {
      const row = state.chapterRows[index];
      if (!row) continue;
      const distance = state.hoverChapterIndex >= 0
        ? Math.abs(index - state.hoverChapterIndex)
        : Infinity;

      row.classList.toggle('row-active', index === state.activeChapterIndex);
      row.classList.toggle('row-hover', index === state.hoverChapterIndex);
      row.classList.toggle('near-1', distance === 1);
      row.classList.toggle('near-2', distance === 2);
    }

    state.chapterVisualActiveIndex = state.activeChapterIndex;
    state.chapterVisualHoverIndex = state.hoverChapterIndex;

    if (scrollHoveredRow && state.hoverChapterIndex >= 0) {
      requestAnimationFrame(() => {
        state.chapterRows[state.hoverChapterIndex]
          ?.scrollIntoView({ block: 'nearest' });
      });
    }
  }

  function getAnswerContentLeft(item) {
    for (const node of [item?.assistantRoot, item?.target]) {
      if (!node?.isConnected) continue;
      const rect = node.getBoundingClientRect();
      if (Number.isFinite(rect.left) && rect.width > 0) return rect.left;
    }
    return null;
  }

  function getLeftObstructionRight(answerLeft) {
    let obstructionRight = 4;
    const candidates = document.querySelectorAll(
      'aside, nav[aria-label], [data-testid*="sidebar"]'
    );

    for (const node of candidates) {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 48 &&
        rect.height > window.innerHeight * 0.45;

      if (visible && rect.left < 24 && rect.right < answerLeft) {
        obstructionRight = Math.max(obstructionRight, rect.right);
      }
    }

    return obstructionRight;
  }

  function updateChapterPosition() {
    if (!state.chapterShell || !state.chapters.length) return;

    const item = state.items[state.activeIndex];
    const answerLeft = getAnswerContentLeft(item);
    if (answerLeft == null) return;

    const anchorX = Math.max(
      CONFIG.chapterCollapsedWidth + 4,
      answerLeft - CONFIG.chapterGapFromAnswer
    );
    const obstructionRight = getLeftObstructionRight(answerLeft);
    const availableWidth = Math.floor(
      anchorX - obstructionRight - CONFIG.chapterObstructionGap
    );

    state.chapterShell.style.setProperty(
      '--chapter-available-width',
      `${Math.max(CONFIG.chapterCollapsedWidth, availableWidth)}px`
    );
    state.chapterShell.dataset.constrained = String(
      availableWidth < CONFIG.chapterCollapsedWidth
    );

    if (availableWidth < CONFIG.chapterCollapsedWidth) return;

    const right = Math.max(4, window.innerWidth - anchorX);
    if (
      state.lastChapterRight === null ||
      Math.abs(state.lastChapterRight - right) >= 0.5
    ) {
      state.lastChapterRight = right;
      state.chapterShell.style.right = `${right}px`;
    }
  }

  function scheduleChapterPositionBurst() {
    if (state.destroyed) return;
    state.layoutBurstUntil = performance.now() + CONFIG.layoutSettleMs;
    if (state.layoutTimer) return;

    const tick = () => {
      state.layoutTimer = null;
      updateChapterPosition();
      if (!state.destroyed && performance.now() < state.layoutBurstUntil) {
        state.layoutTimer = setTimeout(tick, CONFIG.layoutPollMs);
      }
    };

    tick();
  }

  function findLayoutRoots() {
    const item = state.items[state.activeIndex];
    return [...new Set([
      document.documentElement,
      document.querySelector('main, [role="main"]'),
      state.conversationRoot,
      item?.assistantRoot,
      ...document.querySelectorAll('aside, nav[aria-label], [data-testid*="sidebar"]'),
    ].filter(Boolean))];
  }

  function observeLayout() {
    state.resizeObserver?.disconnect();
    if (typeof ResizeObserver !== 'function') return;

    state.resizeObserver = new ResizeObserver(() => {
      state.viewportMetricsDirty = true;
      state.chapterMetrics = null;
      scheduleChapterPositionBurst();
    });

    for (const root of findLayoutRoots()) {
      try {
        state.resizeObserver.observe(root);
      } catch {}
    }
  }

  // =========================================================
  // 7. 跳转 / 当前阅读位置
  // =========================================================

  function getNativeNavigationControl(item) {
    if (item?.nativeControl?.isConnected) return item.nativeControl;

    const navigationId = item?.navigationId;
    if (!navigationId) return null;

    return [...document.querySelectorAll('[data-thread-user-message-navigation-item-id]')]
      .find(control =>
        control.getAttribute('data-thread-user-message-navigation-item-id') === navigationId
      ) || null;
  }

  function alignTargetToStart(target, behavior = 'auto') {
    if (!target?.isConnected) return;

    target.scrollIntoView({
      behavior,
      block: 'start',
      inline: 'nearest',
    });
  }

  function alignItemToStart(item, behavior = 'auto') {
    alignTargetToStart(item?.target, behavior);
  }

  function scrollToItem(index) {
    const item = state.items[index];
    const nativeControl = getNativeNavigationControl(item);

    if (!item || (!item.target?.isConnected && !nativeControl?.isConnected)) {
      scheduleScan();
      return;
    }

    clearTimeout(state.jumpCorrectionTimer);
    clearTimeout(state.navigationScanTimer);

    if (nativeControl?.isConnected) {
      nativeControl.click();
    } else {
      alignItemToStart(item, CONFIG.smoothScroll ? 'smooth' : 'auto');
    }

    setActive(index);

    // 未挂载的虚拟历史项交给 Codex 原生控件载入；随后只做两次低频重扫和一次落点校准。
    if (!item.target?.isConnected) {
      scheduleScan(80);
      state.navigationScanTimer = setTimeout(() => {
        state.navigationScanTimer = null;
        scheduleScan(0);
      }, 520);
    }

    // 平滑滚动期间内容高度可能继续变化；结束后用用户消息锚点再校准一次。
    state.jumpCorrectionTimer = setTimeout(() => {
      const currentItem = item.navigationId
        ? state.items.find(candidate => candidate.navigationId === item.navigationId)
        : item;
      if (!currentItem?.target?.isConnected) return;

      const viewport = getViewportMetrics();
      const rect = currentItem.target.getBoundingClientRect();
      const scrollMarginTop = Number.parseFloat(
        getComputedStyle(currentItem.target).scrollMarginTop
      ) || 0;
      const expectedTop = viewport.top + scrollMarginTop;

      if (Math.abs(rect.top - expectedTop) > 6) {
        alignItemToStart(currentItem, 'auto');
      }
    }, CONFIG.jumpCorrectionMs);
  }

  function scrollToChapter(index) {
    const chapter = state.chapters[index];
    if (!chapter?.heading?.isConnected) {
      scheduleScan(0);
      return;
    }

    clearTimeout(state.jumpCorrectionTimer);
    alignTargetToStart(
      chapter.heading,
      CONFIG.smoothScroll ? 'smooth' : 'auto'
    );

    state.jumpCorrectionTimer = setTimeout(() => {
      if (!chapter.heading?.isConnected) return;

      const viewport = getViewportMetrics();
      const rect = chapter.heading.getBoundingClientRect();
      const scrollMarginTop = Number.parseFloat(
        getComputedStyle(chapter.heading).scrollMarginTop
      ) || 0;
      const expectedTop = viewport.top + scrollMarginTop;

      if (Math.abs(rect.top - expectedTop) > 6) {
        alignTargetToStart(chapter.heading, 'auto');
      }
    }, CONFIG.jumpCorrectionMs);

    state.activeChapterIndex = index;
    updateChapterVisualState(false);
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

    const anchorY = getReadingAnchorY();
    let activeIndex = state.items.findIndex(item => item.target?.isConnected);
    if (activeIndex < 0) {
      updateVisualState(false);
      return;
    }

    for (let index = 0; index < state.items.length; index += 1) {
      const target = state.items[index].target;
      if (!target?.isConnected) continue;
      if (target.getBoundingClientRect().top <= anchorY) activeIndex = index;
      else break;
    }

    setActive(activeIndex);
  }

  function setActive(index) {
    if (state.activeIndex === index) return;
    state.activeIndex = index;
    updateVisualState(false);
    refreshChapters(true);
    observeLayout();
    scheduleChapterPositionBurst();
  }

  // =========================================================
  // 8. 扫描 / SPA
  // =========================================================

  function scanMessages() {
    if (state.destroyed) return;
    state.scanCount += 1;

    const previousActiveRoot = state.items[state.activeIndex]?.assistantRoot || null;

    let uiRecreated = false;
    if (!state.host?.isConnected) {
      createUI();
      uiRecreated = true;
    }

    const conversationRoot = getConversationRoot();
    const nodes = getUserMessageNodes(conversationRoot);
    const seenBoundaries = new Set();
    const loadedItems = [];

    for (const node of nodes) {
      const target = getScrollTarget(node);
      const boundary = getMessageBoundary(node);
      if (!target || !boundary || seenBoundaries.has(boundary)) continue;

      const fullText = extractMessageText(node);
      if (!fullText) continue;

      seenBoundaries.add(boundary);

      loadedItems.push({
        node,
        target,
        boundary,
        navigationId: getNavigationId(node, boundary, target),
        loaded: true,
        previewKnown: true,
        fullText,
        title: truncate(fullText),
      });
    }

    loadedItems.forEach((item, index) => {
      item.assistantRoot = findAssistantRoot(
        conversationRoot,
        item.boundary,
        loadedItems[index + 1]?.boundary || null
      );
    });

    const nextItems = mergeWithNativeNavigation(loadedItems);

    const changed =
      nextItems.length !== state.items.length ||
      nextItems.some((item, i) =>
        item.target !== state.items[i]?.target ||
        item.navigationId !== state.items[i]?.navigationId ||
        item.loaded !== state.items[i]?.loaded ||
        item.fullText !== state.items[i]?.fullText
      );

    state.conversationRoot = conversationRoot;
    const nextScrollRoot = findScrollRoot(
      nextItems.find(item => item.target?.isConnected)?.target || conversationRoot
    );
    if (nextScrollRoot !== state.scrollRoot) {
      state.viewportMetricsDirty = true;
      state.chapterMetrics = null;
    }
    state.scrollRoot = nextScrollRoot;
    state.items = nextItems;

    if (changed || uiRecreated) render();
    updateActiveFromViewport();
    refreshChapters(uiRecreated);
    if (
      uiRecreated ||
      previousActiveRoot !== (state.items[state.activeIndex]?.assistantRoot || null)
    ) {
      observeLayout();
    }
    scheduleChapterPositionBurst();
  }

  function scheduleScan(delay = CONFIG.scanDebounceMs) {
    if (state.destroyed) return;

    if (state.scanTimer || state.scanIdleHandle !== null) {
      if (delay > 0) return;
      clearTimeout(state.scanTimer);
      if (state.scanIdleHandle !== null && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(state.scanIdleHandle);
      }
      state.scanIdleHandle = null;
    }

    state.scanTimer = setTimeout(() => {
      state.scanTimer = null;
      if (typeof requestIdleCallback === 'function') {
        state.scanIdleHandle = requestIdleCallback(() => {
          state.scanIdleHandle = null;
          scanMessages();
        }, { timeout: CONFIG.scanIdleTimeoutMs });
      } else {
        scanMessages();
      }
    }, delay);
  }

  function nodeMatchesOrContains(node, selector) {
    return node?.nodeType === Node.ELEMENT_NODE && (
      node.matches(selector) || node.querySelector(selector)
    );
  }

  function observeDOM() {
    state.mutationObserver?.disconnect();

    state.mutationObserver = new MutationObserver(mutations => {
      const scanSelector = [
        '[data-user-message-bubble]',
        '[data-message-author-role="user"]',
        '[data-testid="user-message"]',
        '[data-message-role="user"]',
        '[data-thread-user-message-navigation-item-id]',
        '[data-markdown-text-style="assistant-message"]',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      ].join(',');

      const needsScan = mutations.some(mutation => {
        if (mutation.type === 'characterData') {
          return Boolean(mutation.target.parentElement?.closest([
            '[data-user-message-bubble]',
            '[data-message-author-role="user"]',
            '[data-testid="user-message"]',
            '[data-message-role="user"]',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          ].join(',')));
        }

        if (mutation.type === 'childList') {
          return [...mutation.addedNodes, ...mutation.removedNodes]
            .some(node => nodeMatchesOrContains(node, scanSelector));
        }

        if (mutation.type !== 'attributes') return false;
        if (mutation.attributeName === 'aria-hidden') return true;
        if (mutation.attributeName === 'class') {
          return Boolean(mutation.target.closest?.([
            '[data-user-message-bubble]',
            '[data-markdown-text-style="assistant-message"] h1',
            '[data-markdown-text-style="assistant-message"] h2',
            '[data-markdown-text-style="assistant-message"] h3',
            '[data-markdown-text-style="assistant-message"] h4',
            '[data-markdown-text-style="assistant-message"] h5',
            '[data-markdown-text-style="assistant-message"] h6',
          ].join(',')));
        }
        return !['style', 'data-state'].includes(mutation.attributeName);
      });
      if (needsScan) scheduleScan();

      const layoutChanged = mutations.some(mutation =>
        mutation.type === 'attributes' &&
        ['class', 'style', 'data-state'].includes(mutation.attributeName) &&
        Boolean(mutation.target.closest?.(
          'aside, nav[aria-label], main, [role="main"], [data-testid*="sidebar"]'
        ))
      );
      if (layoutChanged) scheduleChapterPositionBurst();
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
        'data-markdown-text-style',
        'class',
        'style',
        'aria-hidden',
      ],
    });
  }

  function onAnyScroll(event) {
    if (state.destroyed) return;
    if (event?.composedPath?.().includes(state.host)) return;
    if (state.scrollRAF) return;

    state.scrollRAF = requestAnimationFrame(() => {
      state.scrollRAF = null;
      updateActiveFromViewport();
      const chapterIndex = getActiveChapterIndexFromViewport();
      if (chapterIndex !== state.activeChapterIndex) {
        state.activeChapterIndex = chapterIndex;
        updateChapterVisualState(false);
      }
    });
  }

  function onResize() {
    state.viewportMetricsDirty = true;
    state.chapterMetrics = null;
    onAnyScroll();
    observeLayout();
    scheduleChapterPositionBurst();
  }

  function onVisibilityChange() {
    if (!document.hidden) {
      scheduleScan(0);
      observeLayout();
      scheduleChapterPositionBurst();
    }
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
        renderChapters();
      }

      const nextRouteKey = getRouteKey();
      if (nextRouteKey === state.currentRouteKey) return;

      state.currentRouteKey = nextRouteKey;
      state.items = [];
      state.previewCache.clear();
      state.activeIndex = -1;
      state.hoverIndex = -1;
      state.chapters = [];
      state.chapterRows = [];
      state.activeChapterIndex = -1;
      state.hoverChapterIndex = -1;
      state.chapterMetrics = null;
      state.viewportMetricsDirty = true;
      state.chapterVisualActiveIndex = -2;
      state.chapterVisualHoverIndex = -2;
      state.lastChapterRight = null;

      render();
      renderChapters();

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
    observeLayout();
    watchRoute();
    scheduleChapterPositionBurst();

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
    clearTimeout(state.navigationScanTimer);
    clearTimeout(state.jumpCorrectionTimer);
    clearTimeout(state.layoutTimer);
    clearInterval(state.routeTimer);
    if (state.scrollRAF) cancelAnimationFrame(state.scrollRAF);
    if (state.scanIdleHandle !== null && typeof cancelIdleCallback === 'function') {
      cancelIdleCallback(state.scanIdleHandle);
    }

    state.mutationObserver?.disconnect();
    state.resizeObserver?.disconnect();
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
    diagnostics: () => ({
      scans: state.scanCount,
      items: state.items.length,
      loadedItems: state.items.filter(item => item.loaded !== false).length,
      chapters: state.chapters.length,
    }),
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
