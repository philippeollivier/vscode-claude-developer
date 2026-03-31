import { statusColors } from './state';
import { hexToRgba } from './utils';

export function getDashboardCss(): string {
    return `
        body { font-family: var(--vscode-font-family); padding: 24px; color: var(--vscode-foreground); background: var(--vscode-panel-background); margin: 0; }
        .group { margin-bottom: 28px; }
        .group-header-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--vscode-panel-border); }
        .group-header { font-size: 12px; font-weight: 600; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.5px; margin: 0; padding: 0; border: none; }
        .group-actions { display: flex; align-items: center; gap: 4px; }
        .add-btn-task { display: inline-flex; align-items: center; justify-content: center; }
        .add-btn { background: none; border: none; font-size: 18px; font-weight: 600; cursor: pointer; padding: 0 4px; border-radius: 4px; line-height: 1; opacity: 0.6; transition: opacity 0.15s, background 0.15s; }
        .status-task { background: rgba(110, 200, 160, 0.15); color: #6ec8a0; }
        .add-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
        .card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 14px 16px; margin-bottom: 6px; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
        .card:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
        .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
        .card-title { display: flex; align-items: center; gap: 8px; }
        .card-title h2 { margin: 0; font-size: 14px; font-weight: 600; }
        .card-meta { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
        .status-label { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 500; flex-shrink: 0; }
        ${Object.entries(statusColors).map(([cls, color]) => `.status-label.${cls} { background: ${hexToRgba(color, 0.15)}; color: ${color}; }`).join('\n        ')}
        .card-btn { background: none; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 13px; padding: 2px 4px; border-radius: 4px; opacity: 0; transition: opacity 0.15s; }
        .card:hover .card-btn { opacity: 1; }
        .card-btn:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
        .card-btn-menu { font-size: 16px; font-weight: 700; letter-spacing: 1px; }
        .card-btn-close:hover { color: #e5534b; }
        .fork-child { margin-left: 20px; position: relative; }
        .fork-child::before { content: '\u2442'; position: absolute; left: -16px; top: 14px; color: var(--vscode-descriptionForeground); font-size: 12px; }
        .tail { font-size: 10px; font-family: var(--vscode-editor-font-family); line-height: 1.4; color: var(--vscode-descriptionForeground); max-height: 160px; overflow-y: auto; }
        .tail-line { white-space: pre-wrap; word-break: break-word; }
        .tail-line code { background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06)); padding: 1px 4px; border-radius: 3px; font-size: 10px; }
        .tail-line strong { color: var(--vscode-foreground); }
        .tail-user { color: var(--vscode-foreground); }
        .tail-empty { font-style: italic; }
        .agents-section { margin-top: 8px; border-top: 1px solid var(--vscode-panel-border); padding-top: 6px; }
        .agents-label { font-size: 9px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 4px; }
        .agent-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 10px; }
        .agent-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
        .agent-dot.running { background: #4ec9b0; animation: pulse 1.5s ease-in-out infinite; }
        .agent-desc { color: var(--vscode-foreground); flex: 1; }
        .agent-type { color: var(--vscode-descriptionForeground); font-size: 9px; background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06)); padding: 1px 5px; border-radius: 3px; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .empty { color: var(--vscode-descriptionForeground); font-style: italic; margin-top: 20px; }
        .settings-panel { margin-top: 32px; border-top: 1px solid var(--vscode-panel-border); }
        .settings-toggle { display: flex; align-items: center; gap: 6px; padding: 10px 0; cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; user-select: none; }
        .settings-toggle:hover { color: var(--vscode-foreground); }
        .settings-toggle .arrow { font-size: 10px; transition: transform 0.15s; }
        .settings-toggle .arrow.open { transform: rotate(90deg); }
        .settings-body { display: none; padding: 0 0 12px 0; }
        .settings-body.open { display: block; }
        .settings-section { margin-bottom: 16px; }
        .settings-section h3 { font-size: 11px; font-weight: 600; color: var(--vscode-foreground); margin: 0 0 8px 0; }
        .setting-row { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; }
        .setting-label { font-size: 12px; color: var(--vscode-foreground); }
        .setting-desc { font-size: 10px; color: var(--vscode-descriptionForeground); }
        .toggle-switch { position: relative; width: 36px; height: 20px; flex-shrink: 0; }
        .toggle-switch input { opacity: 0; width: 0; height: 0; }
        .toggle-slider { position: absolute; inset: 0; background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); border-radius: 10px; cursor: pointer; transition: background 0.2s; }
        .toggle-slider::before { content: ''; position: absolute; width: 14px; height: 14px; left: 2px; top: 2px; background: var(--vscode-descriptionForeground); border-radius: 50%; transition: transform 0.2s; }
        .toggle-switch input:checked + .toggle-slider { background: #3bb44a; border-color: #3bb44a; }
        .toggle-switch input:checked + .toggle-slider::before { transform: translateX(16px); background: #fff; }
        .select-wrap { position: relative; }
        .select-wrap select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 3px 8px; font-size: 12px; cursor: pointer; }
        .hotkeys { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; }
        .hotkey-key { font-family: var(--vscode-editor-font-family); font-size: 11px; background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06)); padding: 2px 6px; border-radius: 3px; text-align: right; white-space: nowrap; }
        .hotkey-desc { font-size: 12px; color: var(--vscode-descriptionForeground); }
        .context-menu { position: fixed; z-index: 1000; background: var(--vscode-menu-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 6px; padding: 4px 0; min-width: 180px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
        .context-menu-item { padding: 6px 14px; font-size: 12px; cursor: pointer; color: var(--vscode-menu-foreground, var(--vscode-foreground)); display: flex; align-items: center; gap: 8px; }
        .context-menu-item:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-foreground)); }
        .context-menu-item .skill-slash { opacity: 0.5; }
        .context-menu-item-danger { color: #e5534b; }
        .context-menu-item-danger:hover { background: rgba(229,83,75,0.15); color: #e5534b; }
        .context-menu-separator { height: 1px; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); margin: 4px 0; }
    `;
}
