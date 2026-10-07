const { test } = require('node:test');
const assert = require('node:assert/strict');
const { showSyncPreview } = require('../dist/preview');

function harness(answers) {
  const prompts = [], documents = [], editors = [];
  const ui = {
    window: {
      showWarningMessage: async (message, options, ...buttons) => {
        prompts.push({message,options,buttons});
        const answer = answers.shift();
        return buttons.find(button => button.title === answer);
      },
      showTextDocument: async (document, options) => { editors.push({document,options}); }
    },
    workspace: {openTextDocument: async options => { documents.push(options); return options; }}
  };
  return {ui,prompts,documents,editors};
}

test('thousands of long paths cannot expand the modal; counts and warnings remain visible', async () => {
  const entries = Array.from({length:10000},(_,i) => `DOWNLOAD  ${'nested/'.repeat(200)}file-${i}.txt`);
  const original = [...entries];
  const h = harness(['Apply']);
  const caution = 'Apply overwrites existing files. No files are deleted.';
  assert.equal(await showSyncPreview(h.ui,'WSFTP: 10000 operations',entries,caution),true);
  const {message,options} = h.prompts[0];
  assert.equal(message,'WSFTP: 10000 operations');
  assert.equal(options.modal,true);
  assert.ok(options.detail.length < 650);
  assert.equal(options.detail.split('\n').length,8);
  assert.match(options.detail,/Preview shortened \(10000 entries\)/);
  assert.ok(options.detail.endsWith(caution));
  assert.deepEqual(entries,original);
  assert.equal(h.documents.length,0);
});

test('full preview retains every ordered entry and warning; only the later Apply authorizes changes', async () => {
  const entries = ['DELETE-LOCAL  old.txt','CONFLICT  a.txt ? Both sides changed',...Array.from({length:2000},(_,i) => `DOWNLOAD  dir/file-${i}.txt`)];
  const caution = 'Deletions cannot be undone. Conflicts are skipped.';
  for (const answer of ['Apply','Cancel',undefined]) {
    const h = harness(['Show full preview',answer]);
    assert.equal(await showSyncPreview(h.ui,'WSFTP: 2001 operations, 1 deletion, 1 conflict',entries,caution),answer === 'Apply');
    assert.equal(h.documents.length,1);
    assert.equal(h.documents[0].language,'plaintext');
    assert.ok(h.documents[0].content.endsWith(entries.join('\n')));
    assert.ok(h.documents[0].content.includes(caution));
    assert.equal(h.editors[0].options.preview,false);
    assert.equal(h.prompts.length,2);
    assert.equal(h.prompts[1].options.modal,false);
    assert.match(h.prompts[1].message,/2001 operations, 1 deletion, 1 conflict/);
  }
});

test('cancel and dismissal never open the full preview or authorize operations', async () => {
  for (const answer of ['Cancel',undefined]) {
    const h = harness([answer]);
    assert.equal(await showSyncPreview(h.ui,'WSFTP: upload',['NEW  file.txt'],'Apply transfers all files.'),false);
    assert.equal(h.documents.length,0);
    assert.equal(h.prompts[0].options.detail,'NEW  file.txt\n\nApply transfers all files.');
    assert.equal(h.prompts[0].buttons[1].isCloseAffordance,true);
  }
});

test('conflict-only previews stay bounded and offer inspection without Apply', async () => {
  const entries = Array.from({length:1000},(_,i) => `CONFLICT  file-${i}.txt`);
  const h = harness(['Show full preview']);
  assert.equal(await showSyncPreview(h.ui,'WSFTP: 1000 conflicts; no files changed.',entries,'Resolve conflicts manually.',false),false);
  assert.equal(h.prompts.length,1);
  assert.ok(h.prompts[0].buttons.every(button => button.title !== 'Apply'));
  assert.ok(h.documents[0].content.endsWith(entries.join('\n')));
  assert.match(h.documents[0].content,/No operations will be applied/);
});

test('long scope names and embedded line separators are bounded without changing the full plan', async () => {
  const entry = 'NEW  folder\n\r\t\u2028\u2029'+'x'.repeat(5000);
  const title = 'WSFTP: upload - '+'scope/'.repeat(1000);
  const h = harness(['Show full preview','Cancel']);
  await showSyncPreview(h.ui,title,[entry],'Apply transfers all files.');
  assert.ok(h.prompts[0].message.length <= 140);
  assert.ok(h.prompts[0].options.detail.split('\n')[0].length <= 90);
  assert.equal(h.prompts[0].options.detail.split('\n').length,4);
  assert.ok(h.documents[0].content.startsWith(title));
  assert.ok(h.documents[0].content.endsWith(entry));
});
