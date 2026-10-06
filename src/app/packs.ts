import clear from '../../packs/foundation/assets/art/clear-message.json';
import evidence from '../../packs/foundation/assets/art/evidence-window.json';
import mechanism from '../../packs/foundation/assets/art/mechanism-board.json';
import narrated from '../../packs/foundation/assets/art/narrated-sketch.json';
import operation from '../../packs/foundation/assets/art/operation-notes.json';
import spatial from '../../packs/foundation/assets/art/spatial-object.json';
import landscape from '../../packs/foundation/profiles/presentation-landscape.json';
import vertical from '../../packs/foundation/profiles/social-vertical.json';
export const foundationPacks={art:[clear,evidence,mechanism,narrated,operation,spatial].map(recipe=>({id:recipe.id,name:recipe.nameZh,summary:recipe.summary,palette:recipe.palette,status:'design_proposal'})),profiles:[landscape,vertical]};
export const directorPackContext='可参考内置工作包的设计配方，但所有配方目前为design_proposal，不能声称有现成渲染器或已通过美术验收：'+JSON.stringify(foundationPacks);
export function packBriefContext(id?:string):string{
  if(!id)return '本轮未指定设计配方，可依据对话自行提出视觉简报；不能把设计提案说成已验收风格。';
  const recipe=foundationPacks.art.find(pack=>pack.id===id);if(!recipe)throw new Error('所选设计配方不存在');
  return '用户选择的简报参考：'+JSON.stringify(recipe)+'。这是design_proposal，只作为本轮构图/配色参考；实际生成代码与渲染检查分别验收。';
}
