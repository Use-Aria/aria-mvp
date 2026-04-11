/**
 * Runs via setupFiles — BEFORE any test file modules are imported.
 *
 * Expo's winter runtime (expo/src/winter/runtime.native.ts) installs lazy
 * getters on `global` for structuredClone, __ExpoImportMetaRegistry, URL, etc.
 * When those getters fire during render in a Jest test, they try to require()
 * modules from a scope Jest no longer owns, throwing:
 *   "You are trying to import a file outside of the scope of the test code."
 *
 * Fix: define those properties as non-configurable BEFORE expo is imported.
 * Expo's installGlobal() checks `configurable` and skips properties that can't
 * be overridden (expo/src/winter/installGlobal.ts:90-93), so the lazy getter
 * never gets installed and no require() fires at render time.
 */

// structuredClone — native in Node 17+; mark non-configurable to block expo override
const nativeSC = global.structuredClone
Object.defineProperty(global, 'structuredClone', {
  value: nativeSC || ((v) => JSON.parse(JSON.stringify(v))),
  configurable: false,
  writable: false,
  enumerable: true,
})

// __ExpoImportMetaRegistry — expo's import.meta polyfill; stub it out
Object.defineProperty(global, '__ExpoImportMetaRegistry', {
  value: { url: 'test://mock' },
  configurable: false,
  writable: false,
  enumerable: false,
})
