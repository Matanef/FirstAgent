import { calculator } from "./calculator.js";
import assert from "assert";

function runTest(name, input, expectSuccess, expectContains) {
  const result = calculator(input);

  try {
    assert.strictEqual(result.success, expectSuccess, "success flag mismatch");

    if (expectSuccess) {
      assert.ok(result.data, "missing data");
      assert.strictEqual(typeof result.data.result, "number", "result is not a number");
      assert.strictEqual(typeof result.data.text, "string", "text is not a string");

      if (expectContains) {
        assert.ok(
          result.data.text.includes(expectContains),
          `text does not contain "${expectContains}": ${result.data.text}`
        );
      }
    } else {
      assert.ok(result.error, "expected an error message");
    }

    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}:`, err.message, "\n");
  }
}

function main() {
  console.log("Running calculator tests...\n");

  runTest("Simple division", "29/4", true, "29/4");
  runTest("Natural language division", "how much is 29/4", true, "29/4");
  runTest("Addition and multiplication", "2+2*3", true, "2+2*3");
  runTest("Parentheses", "(2+2)*3", true, "(2+2)*3");

  runTest("Trig degrees", "sin(30)", true, "sin(30)");
  runTest("Trig in sentence", "hey, can you tell me how much is tan(45)", true, "tan(45)");
  runTest("Inverse trig", "asin(0.5)", true, "asin(0.5)");

  runTest("Constant pi", "pi", true, "pi");
  runTest("Power operator", "2^8", true, "2^8");

  runTest("Invalid expression", "hello world", false);
  runTest("No math", "what's up", false);

  console.log("\nTests finished.");
}

main();