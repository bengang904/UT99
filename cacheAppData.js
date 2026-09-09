function syncDataFiles(dbname, baseurl) {
	var retval = {};

	if (typeof dbname === 'undefined') {
		dbname = 'files';
	}

	if (typeof baseurl === 'undefined') {
		baseurl = '';
	}

	// this is appended to files as an arg to defeat XMLHttpRequest cacheing.
	var urlrandomizerarg = '?nocache=' + (Date.now() / 1000 | 0);

	var state = {
		db: null,
		reported_result: false,
		xhrs: {},
		remote_manifest: {},
		remote_manifest_loaded: false,
		local_manifest: {},
		local_manifest_loaded: false,
		total_to_download: 0,
		total_downloaded: 0,
		total_files: 0,
		pending_files: 0
	};

	var log = function (str) {
		console.log('CACHEAPPDATA: ' + str);
	}

	var debug = function (str) {
		// log(str);
	}

	var clear_state = function () {
		for (var i in state.xhrs) {
			state.xhrs[i].abort();
		}
		delete state.db;
		delete state.xhrs;
		delete state.remote_manifest;
		delete state.local_manifest;
	};

	var failed = function (why) {
		if (state.reported_result) {
			return;
		}
		state.reported_result = true;
		log('[FAILURE] ' + why);
		clear_state();
		if (retval.onerror) {
			retval.onerror(why);
		}
	};

	retval.abort = function () {
		failed('Aborted.');
	}

	var succeeded = function () {
		if (state.reported_result) {
			return;
		}
		state.reported_result = true;
		var why = 'File data synchronized (downloaded ' + Math.ceil(state.total_downloaded / 1048576) + ' megabytes in ' + state.total_files + ' files)';
		log('[SUCCESS] ' + why);
		retval.db = state.db;
		retval.manifest = state.remote_manifest;
		clear_state();
		if (retval.onsuccess) {
			retval.onsuccess(why);
		}
	};

	var prevprogress = '';
	var progress = function (str) {
		if (state.reported_result) {
			return;
		}
		if (str === prevprogress) {
			return;
		}
		prevprogress = str;
		log('[PROGRESS] ' + str);
		if (retval.onprogress) {
			retval.onprogress(str);
		}
	}

	debug('Database name is ' + dbname + '.');
	progress('Opening database...');
	var dbopen = window.indexedDB.open(dbname, 1);

	// this is called if we change the version or the database doesn't exist.
	// Use it to create the schema.
	dbopen.onupgradeneeded = function (event) {
		progress('Upgrading/creating local database...');
		// noinspection JSUnresolvedVariable
		var db = event.target.result;
		// noinspection JSUnusedLocalSymbols
		var metadataStore = db.createObjectStore('metadata', {keyPath: 'filename'});
		var dataStore = db.createObjectStore('data', {keyPath: 'chunkid', autoIncrement: true});
		dataStore.createIndex('data', 'filename', {unique: false});
	};

	dbopen.onerror = function (event) {
		// noinspection JSUnresolvedVariable
		failed('Couldn\'t open local database: ' + event.target.error.message);
	};

	var finished_file = function (fname) {
		debug('Finished writing ' + fname + ' to the database!');
		state.pending_files--;
		if (state.pending_files < 0) {
			state.pending_files = 0;
			debug('Uhoh, pending_files went negative?!');
		}
		if (state.pending_files === 0) {
			succeeded();
		}
	};

	var store_file = function (xhr) {
		// write to the database...
		var databuf = xhr.response;
		var transaction = state.db.transaction(['metadata', 'data'], 'readwrite');
		var objstoremetadata = transaction.objectStore('metadata');
		var objstoredata = transaction.objectStore('data');

		objstoremetadata.add({filename: xhr.filename, filesize: xhr.filesize, filetime: xhr.filetime});
		// !!! FIXME: _of course_ this crashes Safari on large files
		/*
		var chunksize = 1048576;  // 1 megabyte each.
		var chunks = Math.ceil(xhr.response.byteLength / chunksize);
		for (var i = 0; i < chunks; i++) {
			var bufoffset = i * chunksize;
			objstoredata.add({
				filename: xhr.filename,
				offset: bufoffset,
				chunk: new Uint8Array(databuf, bufoffset, chunksize);
			});
		}
		*/
		objstoredata.add({filename: xhr.filename, offset: 0, chunk: databuf});

		// noinspection JSUnusedLocalSymbols
		transaction.oncomplete = function (event) {
			finished_file(xhr.filename);  // all done here!
		};
	};

	var download_new_files = function () {
		if (state.reported_result) {
			return;
		}
		progress('Downloading new files...');
		// noinspection JSUnusedLocalSymbols
		var downloadme = [];
		for (var i in state.remote_manifest) {
			var remoteitem = state.remote_manifest[i];
			var remotefname = i;
			if (typeof state.local_manifest[remotefname] !== 'undefined') {
				debug('remote filename ' + remotefname + ' already downloaded.');
			} else {
				debug('remote filename ' + remotefname + ' needs downloading.');
				// the browser will let a handful of these go in parallel, and
				//  then will queue the rest, firing events as appropriate
				//  when it gets around to them, so just fire them all off
				//  here.

				// !!! FIXME: use the Fetch API, plus streaming, as an option.
				// !!! FIXME:  It can use less memory, since it doesn't need
				// !!! FIXME:  to keep the whole file in memory.
				state.total_to_download += remoteitem.filesize;
				state.total_files++;
				state.pending_files++;

				var xhr = new XMLHttpRequest();
				state.xhrs[remotefname] = xhr;
				xhr.previously_loaded = 0;
				xhr.filename = remotefname;
				xhr.filesize = state.remote_manifest[i].filesize;
				xhr.filetime = state.remote_manifest[i].filetime;
				xhr.expected_filesize = remoteitem.filesize;
				xhr.responseType = 'arraybuffer';
				xhr.addEventListener('error', function (e) {
					// noinspection JSUnresolvedVariable
					failed('Download error on ' + e.target.filename + '!');
				});
				xhr.addEventListener('timeout', function (e) {
					// noinspection JSUnresolvedVariable
					failed('Download timeout on ' + e.target.filename + '!');
				});
				xhr.addEventListener('abort', function (e) {
					// noinspection JSUnresolvedVariable
					failed('Download abort on ' + e.target.filename + '!');
				});

				// noinspection DuplicatedCode
				xhr.addEventListener('progress', function (e) {
					if (state.reported_result) {
						return;
					}
					var xhr = e.target;
					var additional = e.loaded - xhr.previously_loaded;
					state.total_downloaded += additional;
					xhr.previously_loaded = e.loaded;
					debug('Downloaded ' + additional + ' more bytes for file ' + xhr.filename);
					//var percent = state.total_to_download ? Math.floor((state.total_downloaded / state.total_to_download) * 100.0) : 0;
					progress('Downloaded (' + Math.ceil(state.total_downloaded / 1048576) + '/' + Math.ceil(state.total_to_download / 1048576) + ')');
				});

				xhr.addEventListener('load', function (e) {
					if (state.reported_result) {
						return;
					}
					var xhr = e.target;
					// noinspection DuplicatedCode
					if (xhr.status !== 200) {
						failed('Server reported failure downloading ' + xhr.filename + '!');
					} else {
						debug('Finished download of ' + xhr.filename + '!');
						state.total_downloaded -= xhr.previously_loaded;
						state.total_downloaded += xhr.expected_filesize;
						xhr.previously_loaded = xhr.expected_filesize;
						delete state.xhrs[xhr.filename];
						//var percent = state.total_to_download ? Math.floor((state.total_downloaded / state.total_to_download) * 100.0) : 0;
						progress('Downloaded (' + Math.ceil(state.total_downloaded / 1048576) + '/' + Math.ceil(state.total_to_download / 1048576) + ')');
						store_file(xhr);
					}
				});

				xhr.open('get', baseurl + remotefname + urlrandomizerarg, true);
				xhr.send();
			}
		}

		if (state.pending_files === 0) {
			succeeded();  // we're already done.  :)
		}
	};

	var delete_old_files = function () {
		if (state.reported_result) {
			return;
		}
		var deleteme = []
		// noinspection JSDuplicatedDeclaration
		for (var i in state.local_manifest) {
			var localitem = state.local_manifest[i];
			var localfname = localitem.filename;
			var removeme = false;
			if (typeof state.remote_manifest[localfname] === 'undefined') {
				removeme = true;
			} else {
				var remoteitem = state.remote_manifest[localfname];
				if ((localitem.filesize !== remoteitem.filesize) ||
					(localitem.filetime !== remoteitem.filetime)) {
					removeme = true;
				}
			}

			if (removeme) {
				debug('Marking old file ' + localfname + ' for removal.');
				deleteme.push(localfname);
				delete state.local_manifest[i];
			}
		}

		if (deleteme.length === 0) {
			debug('No old files to delete.');
			download_new_files();  // just move on to the next stage.
		} else {
			progress('Cleaning up old files...');
			var transaction = state.db.transaction(['data', 'metadata'], 'readwrite');
			// noinspection JSUnusedLocalSymbols
			transaction.oncomplete = function (event) {
				debug('All old files are deleted.');
				download_new_files();
			};

			var objstoremetadata = transaction.objectStore('metadata');
			var objstoredata = transaction.objectStore('data');
			var dataindex = objstoredata.index('data');
			// noinspection JSDuplicatedDeclaration
			for (var i in deleteme) {
				// noinspection JSUnfilteredForInLoop
				debug('Deleting metadata for ' + deleteme[i] + '.');
				// noinspection JSUnfilteredForInLoop
				objstoremetadata.delete(deleteme[i]);
				// noinspection JSUnfilteredForInLoop
				dataindex.openCursor(IDBKeyRange.only(deleteme[i])).onsuccess = function (event) {
					// noinspection JSUnresolvedVariable
					var cursor = event.target.result;
					if (cursor) {
						// noinspection JSUnresolvedVariable
						debug('Deleting file chunk ' + cursor.value.chunkid + ' for ' + cursor.value.filename + ' (offset=' + cursor.value.offset + ', size=' + cursor.value.size + ').');
						// noinspection JSUnresolvedVariable
						objstoredata.delete(cursor.value.chunkid);
						cursor.continue();
					}
				}
			}
		}
	};

	var manifest_loaded = function () {
		if (state.reported_result) {
			return;
		}
		if (state.local_manifest_loaded && state.remote_manifest_loaded) {
			debug('both manifests loaded, moving on to next step.');
			delete_old_files();  // on success, will start downloads.
		}
	};

	var load_local_manifest = function (db) {
		if (state.reported_result) {
			return;
		}
		debug('Loading local manifest...');
		var transaction = db.transaction('metadata', 'readonly');
		var objstore = transaction.objectStore('metadata');
		var cursor = objstore.openCursor();

		// this gets called once for each item in the object store.
		cursor.onsuccess = function (event) {
			if (state.reported_result) {
				return;
			}
			// noinspection JSUnresolvedVariable
			var cursor = event.target.result;
			if (cursor) {
				debug('Another local manifest item: ' + cursor.value.filename);
				state.local_manifest[cursor.value.filename] = cursor.value;
				cursor.continue();
			} else {
				debug('All local manifest items iterated.');
				state.local_manifest_loaded = true;
				manifest_loaded();  // maybe move on to next step.
			}
		};
	};

	dbopen.onsuccess = function (event) {
		debug('Database is open!');
		// noinspection JSUnresolvedVariable
		var db = event.target.result;
		state.db = db;

		// just catch all database errors here, where they will bubble up
		//  from objectstores and transactions.
		db.onerror = function (event) {
			failed('Database error: ' + event.target.error.message);
		};

		progress('Loading file manifests...');

		// this is async, so it happens while remote manifest downloads.
		load_local_manifest(db);

		debug('Loading remote manifest...');
		var xhr = new XMLHttpRequest();
		xhr.responseType = 'text';
		// noinspection JSUnusedLocalSymbols
		xhr.addEventListener('error', function (e) {
			failed('Manifest download error!');
		});
		// noinspection JSUnusedLocalSymbols
		xhr.addEventListener('timeout', function (e) {
			failed('Manifest download timeout!');
		});
		// noinspection JSUnusedLocalSymbols
		xhr.addEventListener('abort', function (e) {
			failed('Manifest download abort!');
		});
		xhr.addEventListener('load', function (e) {
			// noinspection JSUnresolvedVariable
			if (e.target.status !== 200) {
				failed('Server reported failure downloading manifest!');
			} else {
				debug('Remote manifest loaded!');
				// noinspection JSUnresolvedVariable
				debug('json: ' + e.target.responseText);
				state.remote_manifest_loaded = true;
				try {
					// noinspection JSUnresolvedVariable
					state.remote_manifest = JSON.parse(e.target.responseText);
				} catch (e) {
					failed('Remote manifest is corrupted.');
				}
				manifest_loaded();  // maybe move on to next step.
			}
		});
		xhr.open('get', 'manifest.json' + urlrandomizerarg, true);
		xhr.send();
	};

	return retval;
}