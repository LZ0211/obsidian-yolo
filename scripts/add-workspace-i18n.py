import io

def insert_after(path, anchor_line, block):
    """Insert block as new lines immediately after the full anchor line."""
    s = open(path, encoding='utf-8').read()
    assert anchor_line in s, f'anchor missing in {path}: {anchor_line}'
    s = s.replace(anchor_line, anchor_line + '\n' + block, 1)
    open(path, 'w', encoding='utf-8', newline='').write(s)
    print(path, 'patched')

# --- workspaceAgents.editorTitle (zh/en have a workspaceAgents block; it gets the full block below) ---
insert_after('src/i18n/locales/zh.ts',
             '        agentName: "名称",',
             '        editorTitle: "编辑工作空间 Agent",')
insert_after('src/i18n/locales/en.ts',
             '        agentName: "Name",',
             "        editorTitle: 'Edit workspace agent',")

# --- agent-level keys (Workspace Agents card grid) ---
zh_agent = '''    workspaceAgents: "工作空间 Agent",
        newWorkspaceAgent: "新建工作空间 Agent",
        workspaceAgentsDesc: "绑定到工作目录的 Agent 实例。每个实例继承一个模板，并将其文件访问限制在 workspace root 内。",
        deleteWorkspaceAgentTitle: "确认删除工作空间 Agent",
        deleteWorkspaceAgentMessagePrefix: "确定要删除工作空间 Agent",
        deleteWorkspaceAgentMessageSuffix: "？此操作无法撤销。",
        templateBadge: "模板",
        disabledBadge: "已禁用",'''
en_agent = '''    workspaceAgents: 'Workspace Agents',
        newWorkspaceAgent: 'New workspace agent',
        workspaceAgentsDesc: 'Agent instances bound to working directories. Each derives from a template and limits its file access to a workspace root.',
        deleteWorkspaceAgentTitle: 'Confirm delete workspace agent',
        deleteWorkspaceAgentMessagePrefix: 'Are you sure you want to delete workspace agent',
        deleteWorkspaceAgentMessageSuffix: '? This action cannot be undone.',
        templateBadge: 'Template',
        disabledBadge: 'disabled','''
it_agent = '''    workspaceAgents: 'Agent dello spazio di lavoro',
        newWorkspaceAgent: 'Nuovo agent dello spazio di lavoro',
        workspaceAgentsDesc: "Istanza di agent legata a una directory di lavoro: eredita un template e limita l'accesso ai file alla workspace root.",
        deleteWorkspaceAgentTitle: 'Conferma eliminazione agent dello spazio di lavoro',
        deleteWorkspaceAgentMessagePrefix: "Eliminare definitivamente l'agent dello spazio di lavoro",
        deleteWorkspaceAgentMessageSuffix: '? Questa azione non è reversibile.',
        templateBadge: 'Template',
        disabledBadge: 'disattivato','''

for p, block in [('src/i18n/locales/zh.ts', zh_agent),
                 ('src/i18n/locales/en.ts', en_agent),
                 ('src/i18n/locales/it.ts', it_agent)]:
    insert_after(p, '    agent: {', block)

# --- it.ts: full workspaceAgents settings block (was missing entirely) ---
it_workspace = '''  workspaceAgents: {
        sectionTitle: 'Agent dello spazio di lavoro',
        sectionDesc: "Ogni agent dello spazio di lavoro eredita un template Assistant e aggiunge una policy per la directory home.",
        defaultName: 'Nuovo agent dello spazio di lavoro',
        pickTemplate: 'Scegli un template',
        noTemplates: 'Crea prima un Assistant da usare come template.',
        template: 'Template: {name}',
        missingTemplate: 'Template mancante: {id}',
        agentName: 'Nome',
        agentNamePlaceholder: 'Nome agent',
        promptOverride: 'Override del prompt',
        promptOverrideDesc: "Sovrascrive il system prompt del template. Vuoto = eredita dal template.",
        promptOverridePlaceholder: 'Eredita dal template',
        toolOverridesTitle: 'Override strumenti',
        toolOverridesButton: 'Override strumenti',
        toolApprovalMode: 'Modalità approvazione',
        skillOverridesTitle: 'Override competenze',
        skillOverridesButton: 'Override competenze',
        skillLoadMode: 'Modalità caricamento',
        editorTitle: 'Modifica agent dello spazio di lavoro',
      },'''
insert_after('src/i18n/locales/it.ts', '    agent: {', it_workspace)
