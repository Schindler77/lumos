/*
 * NAI Prompt Generator — IndexedDB 저장소
 *
 * stores
 *   kv        : settings 등 (key → value)
 *   chats     : 대화방 (keyPath id) — messages, lastFinalPrompt 포함
 *   reference : 참조 CSV 원본 Blob + metadata (key 'main')
 *
 * IndexedDB를 쓸 수 없는 환경(일부 사생활 보호 모드)에서는 메모리 저장으로 대체하고
 * available=false 로 알린다.
 */
(function (root) {
  'use strict';
  var DB_NAME = 'nai-prompt-generator';
  var DB_VERSION = 1;

  function req(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  function MemoryStore() {
    var data = { kv: new Map(), chats: new Map(), reference: new Map() };
    return {
      available: false,
      get: function (store, key) { return Promise.resolve(data[store].get(key)); },
      put: function (store, value, key) { data[store].set(key != null ? key : value.id, value); return Promise.resolve(); },
      del: function (store, key) { data[store].delete(key); return Promise.resolve(); },
      all: function (store) { return Promise.resolve(Array.from(data[store].values())); }
    };
  }

  function open() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(MemoryStore());
    return new Promise(function (resolve) {
      var r;
      try { r = indexedDB.open(DB_NAME, DB_VERSION); } catch (_) { resolve(MemoryStore()); return; }
      r.onupgradeneeded = function () {
        var db = r.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('chats')) db.createObjectStore('chats', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('reference')) db.createObjectStore('reference');
      };
      r.onerror = function () { resolve(MemoryStore()); };
      r.onblocked = function () { resolve(MemoryStore()); };
      r.onsuccess = function () {
        var db = r.result;
        function tx(store, mode) { return db.transaction(store, mode).objectStore(store); }
        resolve({
          available: true,
          get: function (store, key) { return req(tx(store, 'readonly').get(key)); },
          put: function (store, value, key) {
            var s = tx(store, 'readwrite');
            return req(store === 'chats' ? s.put(value) : s.put(value, key));
          },
          del: function (store, key) { return req(tx(store, 'readwrite').delete(key)); },
          all: function (store) { return req(tx(store, 'readonly').getAll()); }
        });
      };
    });
  }

  root.NAIStorage = { open: open };
})(typeof self !== 'undefined' ? self : this);
