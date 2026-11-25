// Single source of truth for supported languages (used by server and client).

export const LANGUAGES = [
  { id: 'javascript', label: 'JavaScript', monaco: 'javascript', piston: 'javascript', file: 'main.js' },
  { id: 'typescript', label: 'TypeScript', monaco: 'typescript', piston: 'typescript', file: 'main.ts' },
  { id: 'python', label: 'Python', monaco: 'python', piston: 'python', file: 'main.py' },
  { id: 'java', label: 'Java', monaco: 'java', piston: 'java', file: 'Main.java' },
  { id: 'c', label: 'C', monaco: 'c', piston: 'c', file: 'main.c' },
  { id: 'cpp', label: 'C++', monaco: 'cpp', piston: 'c++', file: 'main.cpp' },
  { id: 'go', label: 'Go', monaco: 'go', piston: 'go', file: 'main.go' },
  { id: 'rust', label: 'Rust', monaco: 'rust', piston: 'rust', file: 'main.rs' },
  { id: 'csharp', label: 'C#', monaco: 'csharp', piston: 'csharp', file: 'Main.cs' },
  { id: 'ruby', label: 'Ruby', monaco: 'ruby', piston: 'ruby', file: 'main.rb' },
  { id: 'php', label: 'PHP', monaco: 'php', piston: 'php', file: 'main.php' },
];

export const DEFAULT_LANGUAGE = 'javascript';

export function getLanguage(id) {
  return LANGUAGES.find((l) => l.id === id) || null;
}

export const STARTER_CODE = {
  javascript: '// Welcome to CodeSync\nconsole.log("Hello, CodeSync!");\n',
};

export function starterFor(id) {
  return STARTER_CODE[id] ?? STARTER_CODE.javascript;
}
