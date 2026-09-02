/** 本章一场不剩时，进行中状态应回到开章（角色卡快照），不能留着已删场的进度。 */
export function shouldResetChapterWorkingState(remainingSceneCount: number): boolean {
  return remainingSceneCount <= 0
}
