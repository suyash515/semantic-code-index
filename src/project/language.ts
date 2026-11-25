/** Optional language label inferred from file name; informational only. */
const BY_EXTENSION: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  scala: 'scala', swift: 'swift', m: 'objective-c', mm: 'objective-c', c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp', fs: 'fsharp',
  php: 'php', pl: 'perl', pm: 'perl', lua: 'lua', r: 'r', dart: 'dart', ex: 'elixir', exs: 'elixir',
  erl: 'erlang', hs: 'haskell', clj: 'clojure', elm: 'elm', ml: 'ocaml', zig: 'zig', nim: 'nim',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'powershell', bat: 'batch', cmd: 'batch',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  vue: 'vue', svelte: 'svelte', astro: 'astro',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', xml: 'xml', svg: 'xml',
  md: 'markdown', mdx: 'markdown', rst: 'restructuredtext', txt: 'text',
  hbs: 'handlebars', ejs: 'ejs', njk: 'nunjucks', twig: 'twig', erb: 'erb', jinja: 'jinja', j2: 'jinja',
  tf: 'terraform', hcl: 'hcl', gradle: 'gradle', cmake: 'cmake', mk: 'make'
};

const BY_NAME: Record<string, string> = {
  Dockerfile: 'dockerfile', Makefile: 'make', GNUmakefile: 'make', Rakefile: 'ruby', Gemfile: 'ruby',
  Jenkinsfile: 'groovy', Procfile: 'procfile', Vagrantfile: 'ruby', 'CMakeLists.txt': 'cmake'
};

export function inferLanguage(relPath: string): string | null {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}
