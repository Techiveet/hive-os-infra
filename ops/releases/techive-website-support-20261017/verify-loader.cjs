const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const source = fs.readFileSync(process.argv[2], "utf8");
const script = source.split("return <<<JS\n")[1]?.split("\nJS;")[0];
assert.ok(script, "PHP embed loader template must exist");
const values = {embedUrlJs:"https://hive.techiveet.com/embed/support-bot/test", originJs:"https://hive.techiveet.com", colorJs:"#0369a1", slugJs:"test", nameJs:"Test support", versionJs:"test-version"};
const javascript = script.replace(/\{\$(\w+)\}/g, (_, key) => { assert.ok(key in values, key); return JSON.stringify(values[key]); });
function boot(hidden) {
  const nodes = [];
  const listeners = {};
  const context = {
    location: {origin:"https://techiveet.com"},
    window: {
      matchMedia: () => ({matches:false,addEventListener(){}}),
      addEventListener: (event, handler) => { listeners[event] = handler; },
      setTimeout,
    },
    document: {
      readyState:"complete",
      currentScript:{getAttribute: name => name === "data-hide-launcher" ? String(hidden) : null},
      getElementById: () => null,
      createElement: tag => { const node = {tag,style:{},attributes:{},setAttribute(name,value){this.attributes[name]=value;},contentWindow:{postMessage(){}}}; nodes.push(node); return node; },
      body:{appendChild(){}},
    },
  };
  vm.runInNewContext(javascript, context);
  return {frame:nodes.find(node=>node.tag === "iframe"), api:context.window.HiveAssistant};
}
const hidden = boot(true);
assert.equal(hidden.frame.tabIndex, -1, "Closed host-controlled chat must not receive Tab focus");
assert.equal(hidden.frame.inert, true, "Closed chat descendants must be inert");
assert.equal(hidden.frame.attributes["aria-hidden"], "true");
hidden.api.open();
assert.equal(hidden.frame.tabIndex, 0);
assert.equal(hidden.frame.inert, false);
assert.equal(hidden.frame.attributes["aria-hidden"], "false");
hidden.api.close();
assert.equal(hidden.frame.tabIndex, -1);
assert.equal(hidden.frame.inert, true);
const legacy = boot(false);
assert.notEqual(legacy.frame.inert, true, "Visible legacy launchers must remain operable");
assert.notEqual(legacy.frame.attributes["aria-hidden"], "true");
console.log("PASS: hidden, open, closed-again and legacy keyboard states");
