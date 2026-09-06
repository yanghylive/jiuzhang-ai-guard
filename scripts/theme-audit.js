(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.WBSThemeAudit = api;
  if (typeof window !== 'undefined' && window !== root) {
    window.WBSThemeAudit = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createThemeAudit(options) {
    options = options || {};
    var schedule = options.schedule || function (fn) {
      var request = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : function (callback) { return setTimeout(callback, 16); };
      return request(fn);
    };
    var maxPerFlush = Math.max(1, Number(options.maxPerFlush) || 50);
    var now = options.now || Date.now;
    var Observer = options.MutationObserver || (
      typeof MutationObserver !== 'undefined' ? MutationObserver : null
    );
    var seen = new WeakSet();
    var queue = [];
    var queueCursor = 0;
    var records = [];
    var recordByKey = Object.create(null);
    var observer = null;
    var boundRoot = null;
    var pending = false;

    function classTokens(node) {
      var value = node && node.className;
      if (value && typeof value === 'object' && typeof value.baseVal === 'string') value = value.baseVal;
      return String(value || '').trim().split(/\s+/).filter(Boolean);
    }

    function isOwned(node) {
      var tokens = classTokens(node);
      for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].indexOf('wbs-') === 0) return true;
      }
      return false;
    }

    function semanticText(node) {
      var role = node.getAttribute ? node.getAttribute('role') || '' : '';
      return (node.tagName || '') + ' ' + classTokens(node).join(' ') + ' ' + role;
    }

    function classify(node) {
      var tag = String(node.tagName || '').toLowerCase();
      var semantic = semanticText(node);
      if (tag === 'table') return 'table';
      if (tag === 'blockquote') return 'blockquote';
      if (tag === 'pre' || tag === 'code' || /(?:^|[\s_-])code(?:block|[-_\s]|$)|syntax[-_]?block/i.test(semantic)) return 'code';
      if (/assistantReasoning|assistant[-_]?reasoning|(?:^|[\s_-])reasoning(?:[\s_-]|$)/i.test(semantic)) return 'reasoning';
      if (/write[-_]?file|read[-_]?file|file[-_]?(?:card|compact|operation|result)/i.test(semantic)) return 'file';
      if (/tool[-_]?(?:call|card|use|result|invocation)|toolInvocation/i.test(semantic)) return 'tool';
      if (/questionAnswer|question[-_]?answer|questionFloating|qa[-_]?(?:card|display)/i.test(semantic)) return 'qa';
      if (/assistant[-_]?(?:message|response)|(?:message|response)[-_]?assistant|cb-markdown/i.test(semantic)) return 'assistant';
      if (/(?:^|[\s_-])attachment(?:[\s_-]|$)/i.test(semantic)) return 'attachment';
      if (/(?:^|[\s_-])status(?:[\s_-]|$)/i.test(semantic)) return 'status';
      if (/artifact|attachment[-_]?card|status[-_]?card|answer[-_]?card/i.test(semantic)) return 'card';
      return null;
    }

    function classifyState(node, kind) {
      var semantic = semanticText(node);
      if (kind === 'reasoning') {
        if (/(?:^|[\s_-])streaming(?:[\s_-]|$)/i.test(semantic)) return 'streaming';
        if (/(?:^|[\s_-])complete(?:[\s_-]|$)/i.test(semantic)) return 'complete';
        if (/(?:^|[\s_-])collapsed(?:[\s_-]|$)/i.test(semantic)) return 'collapsed';
      }
      if (kind === 'tool') {
        if (/(?:^|[\s_-])executing(?:[\s_-]|$)/i.test(semantic)) return 'executing';
        if (/(?:^|[\s_-])success(?:[\s_-]|$)/i.test(semantic)) return 'success';
        if (/(?:^|[\s_-])error(?:[\s_-]|$)/i.test(semantic)) return 'error';
      }
      return null;
    }

    function looksLikeSurface(node) {
      var tag = String(node.tagName || '').toLowerCase();
      var semantic = semanticText(node);
      var role = node.getAttribute ? node.getAttribute('role') : null;
      return /(?:^|[\s_-])(?:card|surface|widget|dialog|popover|interactive)(?:[\s_-]|$)/i.test(semantic)
        || /^(dialog|button|menu|listbox|tabpanel)$/.test(role || '')
        || /^(button|details|form)$/.test(tag);
    }

    function fingerprint(node) {
      var tag = String(node.tagName || 'element').toLowerCase();
      var tokens = classTokens(node).filter(function (token) {
        return token !== 'wbs-theme-auto'
          && token.indexOf('wbs-') !== 0
          && !/^\d+$/.test(token)
          && !/^[a-f0-9]{20,}$/i.test(token)
          && !/^_.+_[a-z0-9]{6}_\d+$/i.test(token);
      });
      tokens.sort();
      return (tag + (tokens.length ? '.' + tokens.join('.') : '')).slice(0, 160);
    }

    function remember(type, state, node, originalFingerprint) {
      var fp = originalFingerprint || fingerprint(node);
      var key = type + '\n' + (state || '') + '\n' + fp;
      var existing = recordByKey[key];
      if (existing) {
        existing.count += 1;
        return;
      }
      if (records.length >= 200) return;
      var entry = {
        type: type,
        state: state,
        fingerprint: fp,
        firstSeen: now(),
        count: 1,
      };
      records.push(entry);
      recordByKey[key] = entry;
    }

    function enqueueChildren(node) {
      var children = node && node.children;
      if (!children) return;
      for (var i = 0; i < children.length; i++) {
        if (children[i] && children[i].nodeType === 1) queue.push(children[i]);
      }
    }

    function inspect(node) {
      if (!node || node.nodeType !== 1 || seen.has(node)) return;
      seen.add(node);
      if (isOwned(node)) return;

      var fp = fingerprint(node);
      var kind = classify(node);
      if (kind) {
        var state = classifyState(node, kind);
        node.setAttribute('data-wbs-theme-kind', kind);
        if (state) node.setAttribute('data-wbs-theme-state', state);
        remember(kind, state, node, fp);
      } else if (looksLikeSurface(node)) {
        if (node.classList && node.classList.add) node.classList.add('wbs-theme-auto');
        remember('unknown', null, node, fp);
      }
      enqueueChildren(node);
    }

    function requestFlush() {
      if (pending || queueCursor >= queue.length) return;
      pending = true;
      schedule(function () {
        pending = false;
        flush();
      });
    }

    function flush() {
      var count = 0;
      while (queueCursor < queue.length && count < maxPerFlush) {
        inspect(queue[queueCursor]);
        queueCursor += 1;
        count += 1;
      }
      if (queueCursor >= queue.length) {
        queue = [];
        queueCursor = 0;
      }
      requestFlush();
      return queue.length - queueCursor;
    }

    function onMutations(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i] && mutations[i].addedNodes;
        if (!added) continue;
        for (var j = 0; j < added.length; j++) {
          if (added[j] && added[j].nodeType === 1) queue.push(added[j]);
        }
      }
      requestFlush();
    }

    function disconnect() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      boundRoot = null;
      queue = [];
      queueCursor = 0;
    }

    function bind(rootNode) {
      if (rootNode === boundRoot && observer) return;
      disconnect();
      if (!rootNode || rootNode.nodeType !== 1 || !Observer) return;
      boundRoot = rootNode;
      observer = new Observer(onMutations);
      observer.observe(rootNode, { childList: true, subtree: true });
      enqueueChildren(rootNode);
      requestFlush();
    }

    function summary() {
      return records.map(function (entry) {
        return {
          type: entry.type,
          state: entry.state,
          fingerprint: entry.fingerprint,
          firstSeen: entry.firstSeen,
          count: entry.count,
        };
      });
    }

    return {
      bind: bind,
      disconnect: disconnect,
      flush: flush,
      summary: summary,
      active: function () { return !!observer; },
    };
  }

  return { createThemeAudit: createThemeAudit };
});
