<div align="center">

# Vela — AI Novel Writing IDE

**The next-generation AI-powered novel & fiction writing IDE for web novel authors, indie writers and creative professionals.**

[![React](https://img.shields.io/badge/React-19-blue.svg)](https://reactjs.org/)
[![Electron](https://img.shields.io/badge/Electron-41-black.svg)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6.svg)](https://www.typescriptlang.org/)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-yellow.svg)](https://opensource.org/licenses/GPL-3.0)

[Read in Chinese (中文)](README.md) | [Read in Russian (Русский)](README_RU.md)

[Download](#installation) | [Sponsor the Original Author](#sponsor-the-original-author)

</div>

---

> ### 📌 About This Fork
>
> This repository is a **personal modified version** of [heider-x/vela](https://github.com/heider-x/vela), released under GPL-3.0 as required. The original project was created by and is copyrighted to [heider-x](https://github.com/heider-x); this repository only adds modifications on top of it.
>
> **Main changes relative to upstream** (see [CHANGELOG.md](CHANGELOG.md) for the full record):
>
> - **Fixed drafts falling far short of the target word count**: the word-count instruction changed from a weak hint ("about N characters") to a hard lower bound plus a target range, with length requirements and content boundaries stated separately; the drafting pipeline now has a length gate that auto-continues the draft when output falls below 90% of target
> - **Fixed refinement shrinking the text on every pass**: the refine template now forbids going below the original word count, and any deletion must be compensated in place with concrete detail
> - **Wired up the "target word count" field in the chapter creation dialog**: it previously only went into the history record and never reached the drafting pipeline, so the global setting always won
> - **Fixed character-card extraction failing wholesale on long text**: now auto-batched with tolerant parsing of truncated JSON, and extraction failures are no longer silently reported as success
> - **Added global art style and negative prompts**, per-character image prompts, and manual upload of character portraits
> - Filled in missing i18n keys and duplicated field labels in the settings panel
>
> Windows releases are published in **this repository's** [Releases](https://github.com/zhangzhuowei/vela/releases).

---

> **Vela** is an open-source, privacy-first, local-first AI writing IDE purpose-built for **novel writing**, **web fiction**, and **creative writing**. It deeply integrates LLM-powered workflows (outline generation, chapter drafting, intelligent rewriting, automated review) with a local RAG knowledge base, giving authors an IDE-level immersive creative experience — all running on your own machine with your own API keys (BYOK).

---

## Screenshots

|<img src="public/screenshot/1.png" width="800" alt="Vela AI Novel Writing IDE - Main Editor Interface"/>|
|:---:|
|*Immersive writing workspace with side-by-side AI panel, IDE-grade window management*|

|<img src="public/screenshot/2.png" width="800" alt="Vela AI Writing Workflow - Outline and Chapter Generation"/>|
|:---:|
|*End-to-end AI novel writing pipeline: from worldbuilding to chapter generation*|

<details>
<summary><b>More Screenshots</b></summary>
<br>

<img src="public/screenshot/3.png" width="800" alt="Vela AI Writer - Character Management and World Building"/>
<br/><br/>
<img src="public/screenshot/4.png" width="800" alt="Vela Novel IDE - AI Rewrite and Refinement Pipeline"/>
<br/><br/>
<img src="public/screenshot/5.png" width="800" alt="Vela Writing Tool - Local RAG Knowledge Base Search"/>
<br/><br/>
<img src="public/screenshot/6.png" width="800" alt="Vela Creative Writing IDE - Dark Theme Full View"/>

</details>

---

## Key Features

Vela is not just another chat-based text editor — it is a **production-grade novel writing engine** that deeply integrates LLM capabilities, long-context retrieval (RAG), and automated pipelines for fiction authoring.

### AI-Powered Novel Writing Pipeline

| Capability | Description |
|---|---|
| Worldbuilding | Custom global world settings, core plot axes, character profiles (with cross-chapter dynamic state tracking) |
| Auto Outline | One-click AI generation of "structural skeleton → chapter outlines → scene/emotion/rhythm requirements", supports Three-Act, Hero's Journey and other narrative structures |
| Chapter Drafting | Single-chapter streaming generation, accurately responding to prior context and preset outlines, can be stopped at any time |
| AI Rewrite | Supports paragraph-level or full-chapter rewriting while maintaining character and plot consistency |
| Refine | AI automatically detects grammar errors, typos, and logic gaps, outputting polished suggestions |
| Review | AI evaluates chapters from a reader/editor perspective, identifying pacing, character arc, and foreshadowing issues |
| Triple Post-Process Pipeline | Rewrite → Refine → Review three-stage chain ensuring high-quality chapter output |

### Million-Word Local RAG Knowledge Base

| Capability | Description |
|---|---|
| Bulk Import | One-click import of millions of words of reference novels, world settings documents, character setting collections |
| Vector Semantic Search | Automatically recalls the most relevant setting chunks based on current chapter semantics — say goodbye to character/setting inconsistencies |
| Pure Local Storage | Built-in SQLite + lightweight vector engine, all data stored locally, works offline |

### Extensible Architecture

| Capability | Description |
|---|---|
| BYOK (Bring Your Own Key) | Natively compatible with OpenAI, DeepSeek, Gemini, Claude, Ollama (local offline), Zhipu GLM, etc. Smart routing: use DeepSeek for outlines, Claude for polishing, local models for privacy review |
| MCP Protocol | Native Model Context Protocol integration, attach custom tool servers to extend AI capabilities |
| Usage Analytics | Built-in statistics panel for LLM calls, token consumption, and cost trends |

### IDE-Grade Productivity UI

| Capability | Description |
|---|---|
| Resizable Panels | File tree + editor + AI panel + bottom terminal, flexible combination like VSCode/JetBrains |
| Dark Theme | Optimized dark mode with custom floating title bar and status bar micro-interactions |
| Keyboard Shortcuts | Global shortcuts: Cmd+N new, Cmd+O open, Cmd+=/- zoom |
| Cross-Platform | macOS (dmg) / Windows (nsis) / Linux (AppImage) |

---

## Installation

### Direct Download

Go to [Releases](https://github.com/zhangzhuowei/vela/releases) to download the latest version for your OS:

| Platform | File |
|---|---|
| **Windows** | `Vela-*-setup.exe` (installer, with shortcuts and uninstall entry)<br>`Vela-*-portable.exe` (single-file, extracts to a temp dir on launch) |
| **macOS** (Apple Silicon) | `Vela-Mac-*-arm64-Installer.dmg` |
| **macOS** (Intel) | `Vela-Mac-*-x64-Installer.dmg` |

> **Note for macOS users**: these builds are not signed or notarized with an Apple Developer certificate, so the first launch will report *"Vela is damaged and can't be opened"*. That is Gatekeeper blocking it, not a corrupted download. Run this once and it will work:
>
> ```bash
> xattr -cr /Applications/Vela.app
> ```

> For the upstream original releases, see [heider-x/vela/releases](https://github.com/heider-x/vela/releases).

### Build from Source

```bash
# Requirements: Node.js >= 18, npm >= 9

# 1. Clone the project
git clone https://github.com/zhangzhuowei/vela.git
cd vela

# 2. Install dependencies
npm install

# 3. Start dev server (with hot reload)
npm run dev

# 4. Build for distribution
npm run build
```

> **Note**: You need build tools for native SQLite modules (macOS: Xcode Command Line Tools, Windows: Visual Studio Build Tools).

---

## Model Configuration

Vela supports multiple mainstream LLM providers. Quick setup:

1. Open the app → click **Settings** in the bottom-left
2. Go to **Model Configuration**
3. Click **Add Model**:
   - Select provider: OpenAI / DeepSeek / Gemini / Ollama / Zhipu / Custom
   - Fill in `API Key` and `Base URL` (if using a proxy)
   - Assign recommended models for different tasks (writing / polishing / Embedding retrieval)
4. **Start writing!**

**Supported LLM Providers:**

`OpenAI` · `DeepSeek` · `Google Gemini` · `Anthropic Claude` · `Ollama (Local)` · `Zhipu GLM` · `MiniMax` · `SiliconFlow` · `Any OpenAI-compatible API`

---

## Sponsor the Original Author

Vela's open-source edition is driven by the original author's passion in spare time. If this tool has improved your writing efficiency or you see its commercial potential, feel free to sponsor the original author — see the QR codes and contact info in the [Chinese README](README.md#-赞助与支持原作者--sponsor-the-original-author).

> Those donation channels and referral links belong to the **original author [heider-x](https://github.com/heider-x)**, not to the maintainer of this fork.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **UI Framework** | React 19 + TypeScript + Zustand |
| **Styling** | Tailwind CSS v4 + Radix UI + Lucide Icons |
| **Desktop** | Electron 41 + Vite 8 |
| **Local Storage** | better-sqlite3 (relational) + Lightweight vector engine (RAG) |
| **IPC** | Type-safe IPC channels |
| **AI Integration** | OpenAI-compatible + Gemini Protocol + MCP |

---

## Contributing

We welcome community contributions, including but not limited to:
- Bug fixes
- New AI provider adapters
- UI/UX improvements
- Internationalization (i18n) translations
- Documentation improvements

> For major refactors that affect the upstream project's direction, please discuss with the original author first in the upstream [Issues](https://github.com/heider-x/vela/issues) to avoid direction conflicts.
>
> For issues specific to this fork, please use [this repository's Issues](https://github.com/zhangzhuowei/vela/issues).

---

## License

This project is licensed under [GPL-3.0 License](LICENSE). You are free to run, study, share, and modify the code, but new software based on this modified distribution **must also be open-sourced under GPL-3.0**.

This repository is a modified version of [heider-x/vela](https://github.com/heider-x/vela). Copyright remains with the original author and contributors; the modifications are likewise released under GPL-3.0.

For closed-source commercial licensing, please contact the **original author**.

---

<div align="center">

*Vela — Your AI-powered novel writing companion. Write smarter, not harder.*

</div>

<!--
  SEO Keywords:
  AI novel writing, AI writer, novel writing tool, fiction writing software,
  web novel, creative writing IDE, AI story generator, novel outline generator,
  RAG knowledge base, LLM writing assistant, Electron writing app,
  open source writing tool, DeepSeek writing, Claude writing, BYOK AI
-->
