import { smtpFixture } from './fixture.js';
let fixture;
process.on('message', async message => {
  try {
    let result;
    if (message.command === 'start') {
      fixture = await smtpFixture(message.params);
      result = {
        port: fixture.port,
        seen: fixture.seen
      };
    } else if (message.command === 'snapshot') {
      result = fixture.seen;
    } else if (message.command === 'close') {
      await fixture.close();
      result = true;
    }
    process.send({
      id: message.id,
      result
    });
  } catch (error) {
    process.send({
      id: message.id,
      error: error.stack,
      code: error.code
    });
  }
});
