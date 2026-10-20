import { createCapFixtureServer } from './sdk-cap-http.mjs';
const fixture = createCapFixtureServer(JSON.parse(process.argv[2]));
fixture.server.listen(0, '127.0.0.1', () => process.send({ port: fixture.server.address().port }));
process.on('message', async message => {
  if (message === 'stats') process.send(fixture.stats);
  if (message === 'close') { await fixture.close(); process.exit(0); }
});
