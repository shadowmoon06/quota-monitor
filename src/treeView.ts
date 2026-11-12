import * as vscode from 'vscode';
import { UsageService, WINDOWS, WindowId, setWindow } from './usageService';

export class TreeViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'quotaTree.view';
  private view?: vscode.WebviewView;

  constructor(private readonly extUri: vscode.Uri, private readonly service: UsageService) {
    service.onDidUpdate((s) => this.view?.webview.postMessage({ type: 'update', payload: s }));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'ready' && this.service.latest) {
        view.webview.postMessage({ type: 'update', payload: this.service.latest });
      } else if (msg?.type === 'refresh') {
        await this.service.refresh();
      } else if (msg?.type === 'setWindow' && msg.window in WINDOWS) {
        await setWindow(msg.window as WindowId);
      } else if (msg?.type === 'openSettings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'quotaTree');
      }
    });
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'tree.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'tree.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Quota Tree</title>
</head>
<body>
  <div class="windows" id="windows">
    ${(Object.keys(WINDOWS) as WindowId[]).map((w) => `<button data-w="${w}">${w.toUpperCase()}</button>`).join('')}
  </div>
  <div class="stage"><canvas id="tree" width="128" height="160"></canvas></div>
  <div class="caption" id="caption"></div>
  <div id="agents"></div>
  <div class="footer"><span id="updated"></span> <a href="#" id="settings">settings</a></div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
