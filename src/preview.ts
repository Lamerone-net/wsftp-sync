import type * as vscode from 'vscode';

// Bound both line count and width: native dialogs do not scroll long details.
function compactLine(value: string, limit: number): string {
  const line = value.replace(/[\r\n\t\x00-\x1f\x7f\u2028\u2029]/g,' ');
  return line.length > limit ? line.slice(0,limit-3)+'...' : line;
}

export async function showSyncPreview(
  ui: Pick<typeof vscode,'window' | 'workspace'>,
  title: string,
  entries: string[],
  caution: string,
  canApply = true
): Promise<boolean> {
  const shown = entries.slice(0,5).map(entry => compactLine(entry,90));
  const shortened = entries.length > shown.length || shown.some((line,index) => line !== entries[index]);
  const detail = [...shown,...(shortened ? [`Preview shortened (${entries.length} entries). Use "Show full preview" to see every path.`] : []),'',caution].join('\n');
  const apply = {title:'Apply'};
  const close = {title:canApply ? 'Cancel' : 'OK',isCloseAffordance:true};
  const full = {title:'Show full preview'};
  const buttons = canApply ? [apply,close] : [close];
  const message = compactLine(title,140);
  const answer = await ui.window.showWarningMessage(message,{modal:true,detail},...buttons,full);
  if (answer !== full) return canApply && answer === apply;

  const document = await ui.workspace.openTextDocument({language:'plaintext',content:[
    title,'',caution,'',
    canApply ? 'Use Apply or Cancel in the WSFTP notification. Editing this text does not change the planned operations.' : 'No operations will be applied.',
    '',...entries
  ].join('\n')});
  await ui.window.showTextDocument(document,{preview:false});
  if (!canApply) return false;
  // A non-modal confirmation leaves the full preview scrollable and searchable.
  return await ui.window.showWarningMessage(`${message} — Review the full preview, then Apply or Cancel.`,{modal:false},apply,close) === apply;
}
