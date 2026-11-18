/**
 * V3.1 Skill Engine — deterministic, offline prompt composition.
 * Skills are production recipes, not installed runtime code or AI models.
 * No network requests, credits, file mutations or silent Generate actions.
 */
export type SkillName = "continuity" | "motion" | "start-end" | "quality";
export type SkillScene = { id: number; start: number; duration: number };
export type SkillPrompts = { image: string; motion: string };
export const SKILL_RECIPES: ReadonlyArray<{id:SkillName; label:string; description:string}> = [
  {id:"continuity",label:"Nhất quán nhân vật",description:"Giữ nhân vật, trang phục, nền và ánh sáng đồng nhất"},
  {id:"motion",label:"Chuyển động máy quay",description:"Một chuyển động máy quay rõ ràng, tránh giật hình"},
  {id:"start-end",label:"Ảnh đầu/cuối",description:"Dùng hai JPEG tham chiếu đúng ID cảnh"},
  {id:"quality",label:"Kiểm soát lỗi",description:"Hạn chế biến dạng khuôn mặt, tay và vật thể"},
];
const marker = (name:SkillName) => `[SKILL:${name}]`;
const normalize = (s:string) => s.trim().slice(0,4000);
function appendOnce(source:string,name:SkillName,extra:string) {
  const base=normalize(source);
  if(base.includes(marker(name))) return base;
  return `${base}\n\n${marker(name)} ${extra}`.trim().slice(0,4000);
}
export function applySkillRecipe(scene:SkillScene, prompts:SkillPrompts, name:SkillName):SkillPrompts {
  if(!Number.isInteger(scene.id)||scene.id<0||!Number.isFinite(scene.duration)||scene.duration<=0||scene.duration>8) {
    throw new Error("Cảnh không hợp lệ hoặc vượt quá 8 giây");
  }
  if(!SKILL_RECIPES.some(x=>x.id===name)) throw new Error("Skill không được hỗ trợ");
  const out={image:normalize(prompts.image),motion:normalize(prompts.motion)};
  switch(name) {
    case "continuity":
      out.image=appendOnce(out.image,name,"Dùng ảnh tham chiếu nhân vật đã được cho phép sử dụng; giữ đúng gương mặt, trang phục, màu sắc, ánh sáng và bối cảnh. Không tự thêm người hoặc đổi trang phục.");
      out.motion=appendOnce(out.motion,name,"Nhân vật không đổi danh tính, gương mặt, vóc dáng, trang phục hoặc đặc điểm nhận dạng giữa đầu và cuối clip.");
      break;
    case "motion":
      out.motion=appendOnce(out.motion,name,`Cảnh ${scene.id+1}, thời lượng ${scene.duration.toFixed(2)} giây: chọn một chuyển động máy quay nhẹ và liên tục; giữ chủ thể trong khung, chuyển động tự nhiên, không rung giật hoặc nhảy góc máy.`);
      break;
    case "start-end":
      out.image=appendOnce(out.image,name,`Cảnh ID ${scene.id}: dùng JPEG đầu cảnh làm tham chiếu bố cục. JPEG cuối cảnh là đích tiếp nối; giữ góc nhìn, nhân vật, hướng ánh sáng thống nhất. Kiểm tra bằng mắt vì đây là gợi ý, không phải điều khiển keyframe.`);
      out.motion=appendOnce(out.motion,name,"Bắt đầu từ ảnh đầu và hướng đến bố cục ảnh cuối; chỉ dùng chế độ start/end frames khi model thực tế hỗ trợ.");
      break;
    case "quality":
      out.image=appendOnce(out.image,name,"Ưu tiên chi tiết tự nhiên, đủ ngón tay, không thêm chi, không chữ méo, không vật thể biến dạng.");
      out.motion=appendOnce(out.motion,name,"Kiểm soát méo mặt, tay, trang phục, nhấp nháy, vật thể tan chảy; nếu lỗi hãy giảm mức chuyển động hoặc tạo lại cảnh bị lỗi.");
      break;
  }
  return out;
}
