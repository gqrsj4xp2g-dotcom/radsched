const {test,expect}=require('@playwright/test');
const {writeFile}=require('node:fs/promises');
const {pathToFileURL}=require('node:url');
const {openApp}=require('./helpers');

test('a private HTML backup reopens offline with literal names and without live credentials',async({page,context},testInfo)=>{
  await openApp(page);
  const fixture="O'Neil $& <private>";
  const file=await page.evaluate(name=>{
    _isRestoring=true;
    S.physicians=[{id:81,first:'Synthetic',last:name}];
    USERS.push({id:'synthetic-user',physId:81,email:'fixture@example.invalid',password:'SHOULD_STAY_OUT'});
    const copy=_buildSaveHTML();
    _isRestoring=false;
    return copy;
  },fixture);
  expect(file).not.toContain('SHOULD_STAY_OUT');
  const filename=testInfo.outputPath('private-backup.html');
  await writeFile(filename,file);
  await context.setOffline(true);
  await page.goto(pathToFileURL(filename).href,{waitUntil:'domcontentloaded'});
  const reader=page.locator('#rs-private-reader');
  await expect(reader).toBeVisible();
  await reader.getByText('physicians (1)',{exact:true}).click();
  await expect(reader.locator('details[open] pre')).toContainText(fixture);
  expect(await page.evaluate(()=>S.physicians[0].last)).toBe(fixture);
});
