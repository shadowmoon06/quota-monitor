import * as vscode from 'vscode';
import { Snapshot, UsageService, WINDOWS, WindowId, fmtTokens, setWindow } from './usageService';
import { TreeViewProvider } from './treeView';

export function activate(context: vscode.ExtensionContext): void {
  const service = new UsageService();
  const view = new TreeViewProvider(context.extensionUri, service);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'quotaTree.open';
  status.text = '$(sync~spin) Quota Tree';
  status.show();

  context.subscriptions.push(
    service,
    status,
    vscode.window.registerWebviewViewProvider(TreeViewProvider.viewId, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    service.onDidUpdate((s) => updateStatus(status, s)),
    vscode.commands.registerCommand('quotaTree.refresh', () => service.refresh()),
    vscode.commands.registerCommand('quotaTree.open', () =>
      vscode.commands.executeCommand('workbench.view.extension.quotaTree'),
    ),
    vscode.commands.registerCommand('quotaTree.selectWindow', async () => {
      const pick = await vscode.window.showQuickPick(
        (Object.keys(WINDOWS) as WindowId[]).map((id) => ({ label: WINDOWS[id].label, id })),
        { placeHolder: 'Time window for leaves' },
      );
      if (pick) await setWindow(pick.id);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('quotaTree')) return;
      if (e.affectsConfiguration('quotaTree.refreshIntervalSeconds')) service.schedule();
      void service.refresh();
    }),
  );

  service.start();
}

function updateStatus(item: vscode.StatusBarItem, s: Snapshot): void {
  const parts: string[] = [];
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**Quota Tree** — ${s.windowLabel}\n\n`);
  for (const a of s.agents) {
    if (!a.available) continue;
    const short = a.id === 'claude' ? 'CC' : a.id === 'codex' ? 'CX' : a.name;
    const q = a.quotas[0];
    parts.push(q ? `${short} ${Math.round(q.usedPercent)}%` : `${short} ${fmtTokens(a.windowTokens)}`);
    md.appendMarkdown(`**${a.name}**: ${fmtTokens(a.windowTokens)} in window · ${fmtTokens(a.lifetimeTokens)} total\n\n`);
    for (const qq of a.quotas) {
      md.appendMarkdown(`- ${qq.label}: ${qq.usedPercent.toFixed(0)}%${qq.source === 'budget' ? ' (your budget)' : ''}\n`);
    }
    md.appendMarkdown('\n');
  }
  item.text = `$(pulse) ${parts.length ? parts.join(' · ') : 'no agents'}`;
  item.tooltip = md;
}

export function deactivate(): void {}
