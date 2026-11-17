/** Supplied bilibili-line.svg, embedded so no asset server or external request is needed. */
export const BILIBILI_LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="rgba(0,174,236,1)"><path d="M7.17157 2.75737L10.414 5.99948H13.585L16.8284 2.75737C17.219 2.36685 17.8521 2.36685 18.2426 2.75737C18.6332 3.1479 18.6332 3.78106 18.2426 4.17158L16.414 5.99948L18.5 6.00001C20.433 6.00001 22 7.56701 22 9.50001V17.5C22 19.433 20.433 21 18.5 21H5.5C3.567 21 2 19.433 2 17.5V9.50001C2 7.56701 3.567 6.00001 5.5 6.00001L7.585 5.99948L5.75736 4.17158C5.36684 3.78106 5.36684 3.1479 5.75736 2.75737C6.14788 2.36685 6.78105 2.36685 7.17157 2.75737ZM18.5 8.00001H5.5C4.7203 8.00001 4.07955 8.5949 4.00687 9.35555L4 9.50001V17.5C4 18.2797 4.59489 18.9205 5.35554 18.9931L5.5 19H18.5C19.2797 19 19.9204 18.4051 19.9931 17.6445L20 17.5V9.50001C20 8.67158 19.3284 8.00001 18.5 8.00001ZM8 11C8.55228 11 9 11.4477 9 12V14C9 14.5523 8.55228 15 8 15C7.44772 15 7 14.5523 7 14V12C7 11.4477 7.44772 11 8 11ZM16 11C16.5523 11 17 11.4477 17 12V14C17 14.5523 16.5523 15 16 15C15.4477 15 15 14.5523 15 14V12C15 11.4477 15.4477 11 16 11Z"></path></svg>';
export const BILIBILI_LOGO_URI = `data:image/svg+xml,${encodeURIComponent(BILIBILI_LOGO_SVG)}`;

const ROW = '[role="treeitem"][aria-selected]';
const MARK = 'data-bilibili-session-logo';
const TEXT = 'data-bilibili-session-text';
const installations = new WeakMap<Document, { references: number; close: () => void }>();

// Recognize only the plugin's current source titles, plus its explicit brand prefix.
export function bilibiliTitle(title: string): string | null {
  return /^(?:B站 · |B站 (?:video|dynamic|article): )(.+)$/u.exec(title)?.[1] ?? null;
}

function hasClassPart(element: Element, part: string): boolean {
  return [...element.classList].some(token => token.split(/[_-]/u).includes(part));
}

function titleOf(row: Element): Element | undefined {
  if (!row.matches(ROW) || row.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
  let title: Element | undefined;
  if (row.tagName === 'DIV' && hasClassPart(row, 'sessionRow')) {
    title = [...row.children].find(child => child.tagName === 'SPAN' && hasClassPart(child, 'title'));
  } else if (['DIV', 'BUTTON'].includes(row.tagName) && hasClassPart(row, 'searchResultRow')) {
    const heading = [...row.children].find(child => hasClassPart(child, 'searchResultHeading'));
    title = heading && [...heading.children].find(child => child.tagName === 'SPAN' && hasClassPart(child, 'searchResultTitle'));
  }
  // Never decorate rename inputs or highlighted/unknown title structures.
  return title?.childNodes.length === 1 && title.firstChild?.nodeType === 3 ? title : undefined;
}

function createInstallation(document: Document): () => void {
  const view = document.defaultView!;
  const owned = new Map<Element, Array<[string, string | null]>>();
  const queued = new Set<Element>();
  let closed = false, scheduled = false, ready = false;
  const style = document.createElement('style');
  style.dataset.pluginCss = 'bilibili-session-logo';
  style.textContent = `
[${MARK}][${TEXT}] { position: relative; -webkit-text-fill-color: transparent; text-overflow: clip !important; overflow: hidden; }
[${MARK}][${TEXT}]::before {
  content: ""; position: absolute; inset-inline-start: 0; top: 50%; transform: translateY(-50%);
  width: 16px; height: 16px; background: url("${BILIBILI_LOGO_URI}") center / contain no-repeat;
  text-indent: 0; pointer-events: none;
}
[${MARK}][${TEXT}]::after {
  content: attr(${TEXT}) / ""; position: absolute; inset: 0; inset-inline-start: 22px;
  -webkit-text-fill-color: currentColor; text-indent: 0; overflow: hidden; white-space: nowrap;
  text-overflow: ellipsis; pointer-events: none;
}
[${MARK}][${TEXT}]:is([data-scrolled], [data-clipped])::after {
  inset-inline-end: auto; width: max-content; overflow: visible; text-overflow: clip;
}
`;
  document.head.appendChild(style);
  const restore = (title: Element) => {
    const previous = owned.get(title);
    if (!previous) return;
    owned.delete(title);
    for (const [attribute, value] of previous) {
      if (value === null) title.removeAttribute(attribute);
      else title.setAttribute(attribute, value);
    }
  };
  const update = (row: Element) => {
    const title = row.isConnected ? titleOf(row) : undefined;
    for (const marked of row.querySelectorAll(`[${MARK}]`)) if (marked !== title) restore(marked);
    if (!title) return;
    const text = bilibiliTitle(title.textContent ?? '');
    if (!text || !ready) { restore(title); return; }
    if (!owned.has(title)) owned.set(title, [MARK, TEXT].map(attribute => [attribute, title.getAttribute(attribute)]));
    title.setAttribute(MARK, '');
    title.setAttribute(TEXT, text);
  };
  const schedule = () => {
    if (closed || scheduled || !queued.size) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (closed) return;
      const rows = [...queued];
      queued.clear();
      for (const row of rows) update(row);
    });
  };
  const collect = (node: Node, descendants = false) => {
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    if (!element) return;
    const row = element.closest(ROW);
    if (row) queued.add(row);
    if (descendants) {
      for (const child of element.querySelectorAll(ROW)) queued.add(child);
      const marked = [...element.querySelectorAll(`[${MARK}]`)];
      if (owned.has(element)) marked.push(element);
      for (const title of marked) {
        const owner = title.closest(ROW);
        if (owner) queued.add(owner); else restore(title);
      }
    }
    schedule();
  };
  const observer = new view.MutationObserver(records => {
    if (closed) return;
    for (const record of records) {
      collect(record.target, record.type === 'attributes');
      if (record.type !== 'childList') continue;
      for (const node of record.addedNodes) collect(node, true);
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1 || node.isConnected) continue;
        const element = node as Element;
        restore(element);
        for (const title of element.querySelectorAll(`[${MARK}]`)) restore(title);
      }
    }
  });
  observer.observe(document.body, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['class', 'role', 'aria-selected', 'contenteditable'],
  });
  // CSP or image-load failure keeps the readable original prefix.
  const image = new view.Image();
  image.onload = () => { if (!closed) { ready = true; collect(document.body, true); } };
  image.src = BILIBILI_LOGO_URI;
  return () => {
    closed = true;
    observer.disconnect();
    queued.clear();
    image.onload = null;
    for (const title of [...owned.keys()]) restore(title);
    style.remove();
  };
}

/** Same DOM presentation adapter as dsh-im; no replacement of host text nodes or handlers. */
export function installSessionLogo(document: Document | undefined = globalThis.document): () => void {
  const view = document?.defaultView;
  if (!document?.body || !document.head || !view?.MutationObserver || !view.Image
    || !view.CSS?.supports?.('content', `attr(${TEXT}) / ""`)
    || !view.CSS.supports('-webkit-text-fill-color', 'transparent')) return () => {};
  let entry = installations.get(document);
  if (!entry) {
    entry = { references: 0, close: createInstallation(document) };
    installations.set(document, entry);
  }
  entry.references++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--entry.references > 0) return;
    entry.close();
    installations.delete(document);
  };
}
