/** Words the pet window shows, in the Mac's language. Shared by the main process and the pages. */

/** The name the pet shows for a workspace. The host stores `default-workspace`. */
export function workspaceLabel(title, chinese) {
  if (title !== 'default-workspace') return title
  return chinese ? '默认工作区' : 'Default workspace'
}

export const WORDS = {
  en: {
    newSession: 'New Session',
    settings: 'Settings',
    hidePet: 'Hide Pet',
    noWorkspaces: 'No workspaces',
    untitled: 'Untitled',
    thinking: 'Thinking',
    done: 'Done',
    askPlaceholder: 'Ask something',
    send: 'Send',
  },
  zh: {
    newSession: '新会话',
    settings: '设置',
    hidePet: '隐藏宠物',
    noWorkspaces: '没有工作区',
    untitled: '未命名会话',
    thinking: '正在思考',
    done: '已完成',
    askPlaceholder: '输入问题',
    send: '提交',
  },
}

export const wordsFor = (chinese) => (chinese ? WORDS.zh : WORDS.en)
