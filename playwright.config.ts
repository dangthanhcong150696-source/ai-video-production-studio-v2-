import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests/browser',workers:1,use:{headless:true,launchOptions:{executablePath:'/usr/bin/chromium',args:['--no-sandbox']},baseURL:'http://127.0.0.1:3001'},webServer:{command:'npm start',url:'http://127.0.0.1:3001/api/health',reuseExistingServer:false,env:{DATA_DIR:'/tmp/studio-browser-data'}},reporter:'list'});
