import fs from 'node:fs';
import path from 'node:path';

// Bookmarks and history, stored as JSON files in the app's userData directory.

export interface Entry {
  url: string;
  title: string;
  at: number;
}

const HISTORY_LIMIT = 2000;

function load(file: string): Entry[] {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

export class Library {
  bookmarks: Entry[];
  history: Entry[];
  private bookmarksFile: string;
  private historyFile: string;
  private historyTimer: NodeJS.Timeout | null = null;

  constructor(dir: string) {
    this.bookmarksFile = path.join(dir, 'bookmarks.json');
    this.historyFile = path.join(dir, 'history.json');
    this.bookmarks = load(this.bookmarksFile);
    this.history = load(this.historyFile);
  }

  isBookmarked(url: string): boolean {
    return this.bookmarks.some((b) => b.url === url);
  }

  // Returns whether the url is bookmarked afterwards.
  toggleBookmark(url: string, title: string): boolean {
    const had = this.isBookmarked(url);
    this.bookmarks = had ? this.bookmarks.filter((b) => b.url !== url) : [...this.bookmarks, { url, title: title || url, at: Date.now() }];
    fs.writeFileSync(this.bookmarksFile, JSON.stringify(this.bookmarks, null, 2));
    return !had;
  }

  addVisit(url: string, title: string) {
    if (!/^(https?|file):/.test(url)) return;
    const last = this.history[0];
    if (last?.url === url) {
      last.title = title || last.title;
      last.at = Date.now();
    } else {
      this.history.unshift({ url, title: title || url, at: Date.now() });
      this.history.length = Math.min(this.history.length, HISTORY_LIMIT);
    }
    this.saveHistorySoon();
  }

  // Titles arrive after the navigation; fill in the newest entry for the url.
  updateTitle(url: string, title: string) {
    const entry = this.history.find((h) => h.url === url);
    if (entry && title) {
      entry.title = title;
      this.saveHistorySoon();
    }
  }

  clearHistory() {
    this.history = [];
    this.saveHistory();
  }

  private saveHistorySoon() {
    if (this.historyTimer) return;
    this.historyTimer = setTimeout(() => this.saveHistory(), 1000);
  }

  saveHistory() {
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = null;
    fs.writeFileSync(this.historyFile, JSON.stringify(this.history));
  }
}
