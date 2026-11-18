import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/skillEngine.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }}).outputText;
const { applySkillRecipe, SKILL_RECIPES } = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));
const scene = {id:2,start:12,duration:8};
const original = {image:"Reference image",motion:"Walking slowly"};

test("four offline skill recipes preserve original prompts", () => {
  assert.equal(SKILL_RECIPES.length,4);
  for (const recipe of SKILL_RECIPES) {
    const out=applySkillRecipe(scene,original,recipe.id);
    assert.ok(out.image.includes(original.image));
    assert.ok(out.motion.includes(original.motion));
    assert.ok(out.image.length<=4000 && out.motion.length<=4000);
    assert.deepEqual(applySkillRecipe(scene,out,recipe.id),out);
  }
  assert.deepEqual(original,{image:"Reference image",motion:"Walking slowly"});
});
test("reject durations above scene maximum", () => {
  assert.throws(()=>applySkillRecipe({...scene,duration:9},original,"motion"),/8 giây/);
});
test("reject unknown skill", () => {
  assert.throws(()=>applySkillRecipe(scene,original,"external-provider"),/không được hỗ trợ/);
});
