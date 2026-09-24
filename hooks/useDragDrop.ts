"use client";

import { useState, useCallback, useRef } from "react";

export const MAX_DROP_ENTRIES = 10_000;

const IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules", ".next"]);

interface DroppedFileEntry {
  isFile: true;
  isDirectory: false;
  name: string;
  file(success: (file: File) => void, error?: (error: DOMException) => void): void;
}

interface DroppedDirectoryReader {
  readEntries(success: (entries: DroppedEntry[]) => void, error?: (error: DOMException) => void): void;
}

interface DroppedDirectoryEntry {
  isFile: false;
  isDirectory: true;
  name: string;
  createReader(): DroppedDirectoryReader;
}

type DroppedEntry = DroppedFileEntry | DroppedDirectoryEntry;

type EntryDataTransferItem = DataTransferItem & {
  webkitGetAsEntry?: () => DroppedEntry | null;
};

function readEntryFile(entry: DroppedFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryEntries(entry: DroppedDirectoryEntry): Promise<DroppedEntry[]> {
  const reader = entry.createReader();
  const entries: DroppedEntry[] = [];

  return new Promise((resolve, reject) => {
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

function withRelativeName(file: File, relativePath: string): File {
  if (file.name === relativePath) return file;
  return new File([file], relativePath, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

/** Collects dropped files, preserving folder structure in each returned File.name. */
export async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items) as EntryDataTransferItem[];
  if (items.length === 0 || !items.some((item) => typeof item.webkitGetAsEntry === "function")) {
    return Array.from(dataTransfer.files);
  }
  // Capture entries while the drop event's data store is still readable.
  const droppedItems = items.map((item) => {
    const entry = item.webkitGetAsEntry?.() as DroppedEntry | null | undefined;
    return { entry, file: entry ? null : item.getAsFile() };
  });

  const files: File[] = [];
  let entryCount = 0;

  const visit = async (entry: DroppedEntry, parentPath: string): Promise<void> => {
    entryCount += 1;
    if (entryCount > MAX_DROP_ENTRIES) {
      throw new Error(`A drop can contain at most ${MAX_DROP_ENTRIES} entries`);
    }

    if (entry.isDirectory) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) return;
      const directoryPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      const children = await readDirectoryEntries(entry);
      for (const child of children) await visit(child, directoryPath);
      return;
    }

    const file = await readEntryFile(entry);
    const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
    files.push(withRelativeName(file, relativePath));
  };

  for (const { entry, file } of droppedItems) {
    if (entry) {
      await visit(entry, "");
      continue;
    }
    if (file) files.push(file);
  }

  return files;
}

export function useDragDrop(onDrop: (files: File[]) => void) {
  const [isDragOver, setIsDragOver] = useState(false);
  const counterRef = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.items.length === 0) return;
    e.preventDefault();
    counterRef.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.items.length === 0) return;
    e.preventDefault();
  }, []);

  const handleDragLeave = useCallback(() => {
    counterRef.current -= 1;
    if (counterRef.current <= 0) {
      counterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    counterRef.current = 0;
    setIsDragOver(false);
    onDrop(await collectDroppedFiles(e.dataTransfer));
  }, [onDrop]);

  return { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop };
}
