import type { Document } from './vault.js';

export type DocumentLanguage = 'zh' | 'en';
export const languageKeys = ['coral_note_id', 'coral_language', 'coral_primary'] as const;
export const isDocumentLanguage = (value: unknown): value is DocumentLanguage => value === 'zh' || value === 'en';
export const documentLanguage = (doc: Document): DocumentLanguage => isDocumentLanguage(doc.metadata.coral_language) ? doc.metadata.coral_language : 'zh';
export const isNoteId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export interface NoteLanguageFamily {
  primary: Document;
  versions: { language: DocumentLanguage; document: Document }[];
  grouped: boolean;
  issue?: string;
}

// Filenames alone never establish a relationship: imported .en.md notes stay visible.
export function groupNotes(documents: Document[]) {
  const declared = new Map<string, Document[]>();
  const byUri = new Map<string, NoteLanguageFamily>();
  const single = (doc: Document, issue?: string) => {
    const visible = issue ? { ...doc, warning: [doc.warning, issue].filter(Boolean).join('；') } : doc;
    byUri.set(doc.uri, { primary: visible, versions: [{ language: documentLanguage(doc), document: visible }], grouped: false, issue });
  };
  for (const doc of documents) {
    if (!isNoteId(doc.metadata.coral_note_id)) {
      single(doc, Object.hasOwn(doc.metadata, 'coral_note_id') || Object.hasOwn(doc.metadata, 'coral_primary')
        || Object.hasOwn(doc.metadata, 'coral_language') && !isDocumentLanguage(doc.metadata.coral_language)
        ? '语言版本信息无效，当前文件单独显示' : undefined);
      continue;
    }
    const key = doc.vaultId + ':' + doc.metadata.coral_note_id.toLowerCase();
    const members = declared.get(key) ?? [];
    members.push(doc);
    declared.set(key, members);
  }
  for (const members of declared.values()) {
    const primaries = members.filter(doc => doc.metadata.coral_primary === true);
    const valid = members.length <= 2 && members.every(doc => isDocumentLanguage(doc.metadata.coral_language) && typeof doc.metadata.coral_primary === 'boolean' && !doc.warning)
      && new Set(members.map(doc => doc.metadata.coral_language)).size === members.length
      && (primaries.length === 1 || members.length === 1 && primaries.length === 0);
    if (!valid) {
      members.forEach(doc => single(doc, '语言版本关联有歧义，相关文件分别显示；请检查分组 ID、语言和主版本标记'));
      continue;
    }
    const primary = members.find(doc => doc.metadata.coral_language === 'zh') ?? primaries[0] ?? members[0];
    const family: NoteLanguageFamily = { primary, grouped: true,
      versions: members.map(document => ({ language: documentLanguage(document), document })) };
    members.forEach(doc => byUri.set(doc.uri, family));
  }
  return { byUri, notes: documents.filter(doc => byUri.get(doc.uri)!.primary.uri === doc.uri).map(doc => byUri.get(doc.uri)!.primary) };
}
