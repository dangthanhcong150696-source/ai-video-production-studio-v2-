import {test,expect} from '@playwright/test';
test('upload, inspect workflow, export and download MP4',async({page})=>{
 test.setTimeout(90000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');await expect(page.getByRole('heading',{name:'Studio V2'})).toBeVisible();
 await page.locator('input[type=file]').first().setInputFiles('evidence/smoke-output.mp4');
 await expect(page.getByText('Đang phân tích và chia cảnh…')).toBeHidden({timeout:30000});
 await expect(page.locator('.scene')).toHaveCount(3);
 await page.locator('.scene input[type=file]').nth(1).setInputFiles('evidence/smoke-output.mp4');
 await expect(page.getByText('● Đã thay video')).toBeVisible();
 await expect(page.locator('.node video')).toHaveJSProperty('readyState',4);

 await page.getByRole('button',{name:'Xuất video'}).click();
 await expect(page.getByRole('link',{name:'Tải MP4 hoàn thành'})).toBeVisible({timeout:60000});
 await page.screenshot({path:'evidence/workflow-desktop.png',fullPage:true});
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Tải MP4 hoàn thành'}).click()]);expect(download.suggestedFilename()).toBe('studio-export.mp4');expect(await download.failure()).toBeNull();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'evidence/workflow-mobile.png',fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);expect(errors).toEqual([]);
});
