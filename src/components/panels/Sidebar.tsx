/**
 * Sidebar — 左侧导航面板容器
 *
 * 纯路由容器，根据 sidebarView 切换子视图。
 * 所有子视图已拆分到 sidebar/ 子目录。
 */

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useLayoutStore } from '../../stores/layout-store'
import { ContextMenu } from '../ui/ContextMenu'
import KnowledgePanel from './KnowledgePanel'
import HomeSidebarPanel from './sidebar/HomeSidebarPanel'
import ProjectTree from './sidebar/ProjectTree'
import CharactersView from './sidebar/CharactersView'
import ForeshadowingView from './sidebar/ForeshadowingView'
import SearchView from './sidebar/SearchView'
import TimelineView from './sidebar/TimelineView'
import {
  registerMenuSetter, unregisterMenuSetter,
  type SidebarMenuState,
} from './sidebar/SidebarShared'

/** 左侧面板 */
export default function Sidebar() {
  const { t } = useTranslation('panels')
  const sidebarView = useLayoutStore(s => s.sidebarView)
  // 全局右键菜单状态
  const [sidebarMenu, setSidebarMenu] = useState<SidebarMenuState | null>(null)

  // 注册 / 注销右键菜单 setter
  useEffect(() => {
    registerMenuSetter(setSidebarMenu)
    return () => { unregisterMenuSetter() }
  }, [])

  const viewTitles: Record<string, string> = {
    home:       t('sidebar.home'),
    project:    t('sidebar.project'),
    knowledge:  t('sidebar.knowledge'),
    characters: t('sidebar.characters'),
    foreshadowing: t('sidebar.foreshadowing'),
    timeline:   t('sidebar.timeline'),
    search:     t('sidebar.search'),
  }

  // 搜索 / 时间线自己滚动结果区，顶部的输入框固定不动
  const selfScrolling = sidebarView === 'search' || sidebarView === 'timeline'

  return (
    <div
      className="w-full h-full flex flex-col overflow-hidden"
      style={{
        backgroundColor: 'var(--color-sidebar)',
        borderRight: '1px solid var(--color-border)',
      }}
    >
      <div className="panel-header">
        <span>{viewTitles[sidebarView]}</span>
      </div>
      <div className={`flex-1 py-1 ${selfScrolling ? 'overflow-hidden' : 'overflow-y-auto'}`}>
        {sidebarView === 'home'       && <HomeSidebarPanel />}
        {sidebarView === 'project'    && <ProjectTree />}
        {sidebarView === 'knowledge'  && <KnowledgePanel />}
        {sidebarView === 'characters' && <CharactersView />}
        {sidebarView === 'foreshadowing' && <ForeshadowingView />}
        {sidebarView === 'timeline'   && <TimelineView />}
        {sidebarView === 'search'     && <SearchView />}
      </div>

      {/* 动态右键菜单 */}
      {sidebarMenu && (
        <ContextMenu
          items={sidebarMenu.items}
          position={sidebarMenu.position}
          onClose={() => setSidebarMenu(null)}
        />
      )}
    </div>
  )
}

// 保持向后兼容的 re-export（外部引用了 chapterTitleCache）
// eslint-disable-next-line react-refresh/only-export-components -- 兼容旧引用路径的再导出
export { chapterTitleCache, clearChapterTitleCache } from './sidebar/ManuscriptGroup'
