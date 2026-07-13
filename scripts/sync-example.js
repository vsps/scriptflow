const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const exampleMd = fs.readFileSync(path.join(root, 'example.md'), 'utf8').replace(/\r\n/g, '\n').trim();
const uiPath = path.join(root, 'ui.html');
const ui = fs.readFileSync(uiPath, 'utf8');

const escaped = exampleMd.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const textareaPattern = /(<textarea id="input" spellcheck="false">)[\s\S]*?(<\/textarea>)/;
if (!textareaPattern.test(ui)) {
  throw new Error('Could not find #input textarea in ui.html');
}

const nextUi = ui.replace(textareaPattern, (_match, open, close) => `${open}${escaped}${close}`);
fs.writeFileSync(uiPath, nextUi);
