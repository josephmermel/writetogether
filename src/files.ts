// Save/open JSON files. Uses the File System Access API (Chrome/Edge) so the user picks the location;
// falls back to a download / <input type=file> elsewhere (Safari, Firefox).
type Picker = {
  showSaveFilePicker?: (o: unknown) => Promise<{ createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> }>;
  showOpenFilePicker?: (o: unknown) => Promise<{ getFile(): Promise<File> }[]>;
};
const w = window as unknown as Picker;
const types = [{ description: 'JSON', accept: { 'application/json': ['.json'] } }];
const cancelled = (e: unknown) => (e as Error)?.name === 'AbortError';

/** Returns false if the user cancelled. */
export async function saveTextFile(suggestedName: string, data: string): Promise<boolean> {
  if (w.showSaveFilePicker) {
    try {
      const h = await w.showSaveFilePicker({ suggestedName, types });
      const s = await h.createWritable();
      await s.write(data); await s.close();
      return true;
    } catch (e) { if (cancelled(e)) return false; throw e; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = suggestedName; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}

/** Returns the file's text, or null if cancelled. */
export async function openTextFile(): Promise<string | null> {
  if (w.showOpenFilePicker) {
    try {
      const [h] = await w.showOpenFilePicker({ types, multiple: false });
      return await (await h.getFile()).text();
    } catch (e) { if (cancelled(e)) return null; throw e; }
  }
  return new Promise(res => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = 'application/json,.json';
    i.onchange = async () => res(i.files?.[0] ? await i.files[0].text() : null);
    i.oncancel = () => res(null);
    i.click();
  });
}

export interface PickedFile { name: string; text: string }

/** Pick several files at once (chat exports as .json, or plain .txt/.md scene notes). Empty list if cancelled. */
export async function openTextFiles(): Promise<PickedFile[]> {
  const read = async (fs: File[]) => Promise.all(fs.map(async f => ({ name: f.name, text: await f.text() })));
  if (w.showOpenFilePicker) {
    try {
      const hs = await w.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'Chats and notes', accept: { 'application/json': ['.json'], 'text/plain': ['.txt', '.md'] } }],
      });
      return read(await Promise.all(hs.map(h => h.getFile())));
    } catch (e) { if (cancelled(e)) return []; throw e; }
  }
  return new Promise(res => {
    const i = document.createElement('input');
    i.type = 'file'; i.multiple = true; i.accept = '.json,.txt,.md,application/json,text/plain';
    i.onchange = async () => res(i.files ? await read([...i.files]) : []);
    i.oncancel = () => res([]);
    i.click();
  });
}
