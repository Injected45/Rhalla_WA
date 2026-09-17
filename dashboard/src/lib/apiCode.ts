// Shared API code-snippet generator used by the Message Tester and the
// per-card "dev" API dialog. Generates a request in several languages.

export type CodeLang = 'curl' | 'javascript' | 'python' | 'php' | 'csharp' | 'vb';

export const codeLangs: { id: CodeLang; label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'python', label: 'Python' },
  { id: 'php', label: 'PHP' },
  { id: 'csharp', label: 'C#' },
  { id: 'vb', label: 'Visual Basic' },
];

export function apiUrlFor(path: string): string {
  return `${window.location.origin}/api${path}`;
}

export function genCode(lang: CodeLang, method: string, url: string, body?: Record<string, unknown>): string {
  const M = method.toUpperCase();
  const hasBody = body !== undefined && body !== null;
  const json = hasBody ? JSON.stringify(body, null, 2) : '';
  const inline = hasBody ? JSON.stringify(body) : '';

  switch (lang) {
    case 'curl': {
      let s = `curl -X ${M} "${url}" \\\n  -H "X-API-Key: YOUR_API_KEY"`;
      if (hasBody) s += ` \\\n  -H "Content-Type: application/json" \\\n  -d '${inline}'`;
      return s;
    }
    case 'javascript': {
      const headers = hasBody
        ? `{\n    "Content-Type": "application/json",\n    "X-API-Key": "YOUR_API_KEY",\n  }`
        : `{ "X-API-Key": "YOUR_API_KEY" }`;
      let s = `const response = await fetch("${url}", {\n  method: "${M}",\n  headers: ${headers},`;
      if (hasBody) s += `\n  body: JSON.stringify(${json}),`;
      s += `\n});\nconst data = await response.json();\nconsole.log(data);`;
      return s;
    }
    case 'python': {
      const fn = M.toLowerCase();
      const py = hasBody
        ? json.replace(/: true/g, ': True').replace(/: false/g, ': False').replace(/: null/g, ': None')
        : '';
      let s = `import requests\n\nresponse = requests.${fn}(\n    "${url}",\n    headers={"X-API-Key": "YOUR_API_KEY"},`;
      if (hasBody) s += `\n    json=${py},`;
      s += `\n)\nprint(response.json())`;
      return s;
    }
    case 'php': {
      const headers = hasBody
        ? `[\n    "Content-Type: application/json",\n    "X-API-Key: YOUR_API_KEY",\n]`
        : `[\n    "X-API-Key: YOUR_API_KEY",\n]`;
      let s = `<?php\n$ch = curl_init("${url}");\ncurl_setopt($ch, CURLOPT_RETURNTRANSFER, true);\ncurl_setopt($ch, CURLOPT_CUSTOMREQUEST, "${M}");\ncurl_setopt($ch, CURLOPT_HTTPHEADER, ${headers});\n`;
      if (hasBody) s += `curl_setopt($ch, CURLOPT_POSTFIELDS, '${inline}');\n`;
      s += `$response = curl_exec($ch);\ncurl_close($ch);\necho $response;`;
      return s;
    }
    case 'csharp': {
      let s = `using System.Net.Http;\n`;
      if (hasBody) s += `using System.Text;\n`;
      s += `\nvar client = new HttpClient();\nvar request = new HttpRequestMessage(new HttpMethod("${M}"), "${url}");\nrequest.Headers.Add("X-API-Key", "YOUR_API_KEY");\n`;
      if (hasBody) s += `request.Content = new StringContent(@"${inline.replace(/"/g, '""')}", Encoding.UTF8, "application/json");\n`;
      s += `var response = await client.SendAsync(request);\nConsole.WriteLine(await response.Content.ReadAsStringAsync());`;
      return s;
    }
    case 'vb': {
      let s = `Imports System.Net.Http\n`;
      if (hasBody) s += `Imports System.Text\n`;
      s += `\nDim client As New HttpClient()\nDim request As New HttpRequestMessage(New HttpMethod("${M}"), "${url}")\nrequest.Headers.Add("X-API-Key", "YOUR_API_KEY")\n`;
      if (hasBody) s += `request.Content = New StringContent("${inline.replace(/"/g, '""')}", Encoding.UTF8, "application/json")\n`;
      s += `Dim response = Await client.SendAsync(request)\nConsole.WriteLine(Await response.Content.ReadAsStringAsync())`;
      return s;
    }
  }
}
