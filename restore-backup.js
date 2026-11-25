const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

const [backupDirectoryArgument, storageDirectoryArgument, databaseFileArgument] = process.argv.slice(2);
if (!backupDirectoryArgument || !storageDirectoryArgument) {
  fail('Penggunaan: node restore-backup.js <folder-backup> <folder-storage> [file-database]');
} else {
  const backupDirectory = path.resolve(backupDirectoryArgument);
  const storageDirectory = path.resolve(storageDirectoryArgument);
  const databaseFile = path.resolve(databaseFileArgument || path.join(storageDirectory, 'spmb.sqlite'));
  const relativeDatabaseFile = path.relative(storageDirectory, databaseFile);
  const backupRelativeToStorage = path.relative(storageDirectory, backupDirectory);
  const storageRelativeToBackup = path.relative(backupDirectory, storageDirectory);
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
  const stageDirectory = path.join(storageDirectory, '.restore-stage-' + timestamp);
  const targets = [
    { staged: path.join(stageDirectory, 'spmb.sqlite'), final: databaseFile },
    { staged: path.join(stageDirectory, 'uploads'), final: path.join(storageDirectory, 'uploads') },
    { staged: path.join(stageDirectory, 'public-files'), final: path.join(storageDirectory, 'public-files') }
  ];
  const movedOld = [];
  const installed = [];
  let restoreCommitted = false;

  try {
    if (!fs.statSync(backupDirectory).isDirectory()) throw new Error('Folder backup tidak valid.');
    if (!fs.statSync(storageDirectory).isDirectory()) throw new Error('Folder storage tidak valid.');
    if (relativeDatabaseFile === '..' || relativeDatabaseFile.startsWith('..' + path.sep) || path.isAbsolute(relativeDatabaseFile)) {
      throw new Error('File database harus berada di dalam folder storage yang ditentukan.');
    }
    const backupInsideStorage = backupRelativeToStorage !== '..' &&
      !backupRelativeToStorage.startsWith('..' + path.sep) && !path.isAbsolute(backupRelativeToStorage);
    const storageInsideBackup = storageRelativeToBackup !== '..' &&
      !storageRelativeToBackup.startsWith('..' + path.sep) && !path.isAbsolute(storageRelativeToBackup);
    if (backupInsideStorage || storageInsideBackup) {
      throw new Error('Folder backup dan storage tidak boleh saling bertumpuk.');
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDirectory, 'manifest.json'), 'utf8'));
    if (manifest.version !== 1 || typeof manifest.databaseSha256 !== 'string') {
      throw new Error('Versi atau isi manifest backup tidak didukung.');
    }
    const backupDatabase = path.join(backupDirectory, 'spmb.sqlite');
    const databaseBytes = fs.readFileSync(backupDatabase);
    if (databaseBytes.subarray(0, 16).toString('ascii') !== 'SQLite format 3\u0000') {
      throw new Error('Database pada backup bukan file SQLite yang valid.');
    }
    const checksum = crypto.createHash('sha256').update(databaseBytes).digest('hex');
    if (checksum !== manifest.databaseSha256) throw new Error('Checksum database backup tidak cocok.');
    ['uploads', 'public-files'].forEach(function (name) {
      if (!fs.statSync(path.join(backupDirectory, name)).isDirectory()) {
        throw new Error('Folder ' + name + ' tidak ditemukan pada backup.');
      }
    });

    fs.mkdirSync(stageDirectory, { recursive: false, mode: 0o700 });
    fs.copyFileSync(backupDatabase, targets[0].staged, fs.constants.COPYFILE_EXCL);
    const validationDatabase = new DatabaseSync(targets[0].staged, { readOnly: true });
    try {
      const integrity = validationDatabase.prepare('PRAGMA integrity_check').get();
      if (!integrity || integrity.integrity_check !== 'ok') throw new Error('Pemeriksaan integritas database backup gagal.');
    } finally {
      validationDatabase.close();
    }
    fs.cpSync(path.join(backupDirectory, 'uploads'), targets[1].staged, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    fs.cpSync(path.join(backupDirectory, 'public-files'), targets[2].staged, {
      recursive: true,
      errorOnExist: true,
      force: false
    });

    targets.forEach(function (target) {
      if (!fs.existsSync(target.final)) return;
      const previous = target.final + '.pre-restore-' + timestamp;
      fs.renameSync(target.final, previous);
      movedOld.push({ final: target.final, previous: previous });
    });
    targets.forEach(function (target) {
      fs.renameSync(target.staged, target.final);
      installed.push(target.final);
    });
    restoreCommitted = true;
    console.log('Pemulihan berhasil dari ' + path.basename(backupDirectory) + '.');
    console.log('Data sebelumnya dipertahankan dengan akhiran .pre-restore-' + timestamp + '.');
    console.log('Mulai ulang server aplikasi sebelum menerima permintaan baru.');
  } catch (error) {
    for (let index = installed.length - 1; index >= 0; index -= 1) {
      const installedPath = installed[index];
      if (fs.existsSync(installedPath)) fs.rmSync(installedPath, { recursive: true, force: true });
    }
    for (let index = movedOld.length - 1; index >= 0; index -= 1) {
      const previous = movedOld[index];
      if (fs.existsSync(previous.previous)) fs.renameSync(previous.previous, previous.final);
    }
    fail('Pemulihan gagal: ' + error.message);
  } finally {
    if (fs.existsSync(stageDirectory)) fs.rmSync(stageDirectory, { recursive: true, force: true });
    if (!restoreCommitted) console.error('Data backup sumber tidak diubah.');
  }
}
