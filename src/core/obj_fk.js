function startNewCataloging() {
    Catalog.prototype = {
        get metadata() {
            return shadow(this, 'metadata', this.catalogObj["metadata"]);
        },
        get toplevelPagesDict() {
            var pagesObj = this.catDict.get('Pages');
            assertWellFormed(isDict(pagesObj), 'invalid top-level pages dictionary');
            // shadow the prototype getter
            return shadow(this, 'toplevelPagesDict', pagesObj);
        },
        get documentOutline() {
            var obj = null;
            try {
                obj = this.readDocumentOutline();
            } catch (ex) {
                if (ex instanceof MissingDataException) {
                    throw ex;
                }
                warn('Unable to read document outline');
            }
            return shadow(this, 'documentOutline', obj);
        },
        readDocumentOutline: function Catalog_readDocumentOutline() {
            var rootItems = this.catalogObj["documentOutline"];
            return rootItems.length > 0 ? rootItems : null;
        },
        get numPages() {
            var obj = this.toplevelPagesDict.get('Count');
            assertWellFormed(
                isInt(obj),
                'page count in top level pages object is not an integer'
            );
            // shadow the prototype getter
            return shadow(this, 'num', obj);
        },
        get destinations() {
            function fetchDestination(dest) {
                return isDict(dest) ? dest.get('D') : dest;
            }

            var xref = this.xref;
            var dests = {}, nameTreeRef, nameDictionaryRef;
            var obj = this.catDict.get('Names');
            if (obj) {
                nameTreeRef = obj.getRaw('Dests');
            } else if (this.catDict.has('Dests')) {
                nameDictionaryRef = this.catDict.get('Dests');
            }

            if (nameDictionaryRef) {
                // reading simple destination dictionary
                obj = nameDictionaryRef;
                obj.forEach(function catalogForEach(key, value) {
                    if (!value) {
                        return;
                    }
                    dests[key] = fetchDestination(value);
                });
            }
            if (nameTreeRef) {
                var nameTree = new NameTree(nameTreeRef, xref);
                var names = nameTree.getAll();
                for (var name in names) {
                    if (!names.hasOwnProperty(name)) {
                        continue;
                    }
                    dests[name] = fetchDestination(names[name]);
                }
            }
            return shadow(this, 'destinations', dests);
        },
        get javaScript() {
            var xref = this.xref;
            var obj = this.catDict.get('Names');

            var javaScript = [];
            if (obj && obj.has('JavaScript')) {
                var nameTree = new NameTree(obj.getRaw('JavaScript'), xref);
                var names = nameTree.getAll();
                for (var name in names) {
                    if (!names.hasOwnProperty(name)) {
                        continue;
                    }
                    // We don't really use the JavaScript right now so this code is
                    // defensive so we don't cause errors on document load.
                    var jsDict = names[name];
                    if (!isDict(jsDict)) {
                        continue;
                    }
                    var type = jsDict.get('S');
                    if (!isName(type) || type.name !== 'JavaScript') {
                        continue;
                    }
                    var js = jsDict.get('JS');
                    if (!isString(js) && !isStream(js)) {
                        continue;
                    }
                    if (isStream(js)) {
                        js = bytesToString(js.getBytes());
                    }
                    javaScript.push(stringToPDFString(js));
                }
            }
            return shadow(this, 'javaScript', javaScript);
        },

        cleanup: function Catalog_cleanup() {
            this.fontCache.forEach(function (font) {
                delete font.sent;
                delete font.translated;
            });
            this.fontCache.clear();
        },

        getPage: function Catalog_getPage(pageIndex) {
            if (!(pageIndex in this.pagePromises)) {
                this.pagePromises[pageIndex] = this.getPageDict(pageIndex).then(
                    function (a) {
                        PdfObjectParser_FK.PDF_FK["pages"] = PdfObjectParser_FK.PDF_FK["pages"] || [];
                        PdfObjectParser_FK.PDF_FK["pages"][pageIndex] = PdfObjectParser_FK.serializeObject(a);
                        var dict = a[0];
                        var ref = a[1];
                        return new Page(this.pdfManager, this.xref, pageIndex, dict, ref,
                            this.fontCache);
                    }.bind(this)
                );
            }
            return this.pagePromises[pageIndex];
        },

        getPageDict: function Catalog_getPageDict(pageIndex) {
            var promise = new LegacyPromise();
            var nodesToVisit = [this.catDict.getRaw('Pages')];
            var currentPageIndex = 0;
            var xref = this.xref;

            function next() {
                while (nodesToVisit.length) {
                    var currentNode = nodesToVisit.pop();

                    if (isRef(currentNode)) {
                        xref.fetchAsync(currentNode).then(function (obj) {
                            if ((isDict(obj, 'Page') || (isDict(obj) && !obj.has('Kids')))) {
                                if (pageIndex === currentPageIndex) {
                                    promise.resolve([obj, currentNode]);
                                } else {
                                    currentPageIndex++;
                                    next();
                                }
                                return;
                            }
                            nodesToVisit.push(obj);
                            next();
                        }.bind(this), promise.reject.bind(promise));
                        return;
                    }

                    // must be a child page dictionary
                    assert(
                        isDict(currentNode),
                        'page dictionary kid reference points to wrong type of object'
                    );
                    var count = currentNode.get('Count');
                    // Skip nodes where the page can't be.
                    if (currentPageIndex + count <= pageIndex) {
                        currentPageIndex += count;
                        continue;
                    }

                    var kids = currentNode.get('Kids');
                    assert(isArray(kids), 'page dictionary kids object is not an array');
                    if (count === kids.length) {
                        // Nodes that don't have the page have been skipped and this is the
                        // bottom of the tree which means the page requested must be a
                        // descendant of this pages node. Ideally we would just resolve the
                        // promise with the page ref here, but there is the case where more
                        // pages nodes could link to single a page (see issue 3666 pdf). To
                        // handle this push it back on the queue so if it is a pages node it
                        // will be descended into.
                        nodesToVisit = [kids[pageIndex - currentPageIndex]];
                        currentPageIndex = pageIndex;
                        continue;
                    } else {
                        for (var last = kids.length - 1; last >= 0; last--) {
                            nodesToVisit.push(kids[last]);
                        }
                    }
                }
                promise.reject('Page index ' + pageIndex + ' not found.');
            }

            next();
            return promise;
        },

        getPageIndex: function Catalog_getPageIndex(ref) {
            // The page tree nodes have the count of all the leaves below them. To get
            // how many pages are before we just have to walk up the tree and keep
            // adding the count of siblings to the left of the node.
            var xref = this.xref;

            function pagesBeforeRef(kidRef) {
                var total = 0;
                var parentRef;
                return xref.fetchAsync(kidRef).then(function (node) {
                    if (!node) {
                        return null;
                    }
                    parentRef = node.getRaw('Parent');
                    return node.getAsync('Parent');
                }).then(function (parent) {
                        if (!parent) {
                            return null;
                        }
                        return parent.getAsync('Kids');
                    }).then(function (kids) {
                        if (!kids) {
                            return null;
                        }
                        var kidPromises = [];
                        var found = false;
                        for (var i = 0; i < kids.length; i++) {
                            var kid = kids[i];
                            assert(isRef(kid), 'kids must be an ref');
                            if (kid.num == kidRef.num) {
                                found = true;
                                break;
                            }
                            kidPromises.push(xref.fetchAsync(kid).then(function (kid) {
                                if (kid.has('Count')) {
                                    var count = kid.get('Count');
                                    total += count;
                                } else { // page leaf node
                                    total++;
                                }
                            }));
                        }
                        if (!found) {
                            error('kid ref not found in parents kids');
                        }
                        return Promise.all(kidPromises).then(function () {
                            return [total, parentRef];
                        });
                    });
            }

            var total = 0;

            function next(ref) {
                return pagesBeforeRef(ref).then(function (args) {
                    if (!args) {
                        return total;
                    }
                    var count = args[0];
                    var parentRef = args[1];
                    total += count;
                    return next(parentRef);
                });
            }

            return next(ref);
        }
    };
};
function startOldCataloging() {
    Catalog.prototype = {
        get metadata() {
            var streamRef = this.catDict.getRaw('Metadata');
            if (!isRef(streamRef)) {
                return shadow(this, 'metadata', null);
            }

            var encryptMetadata = !this.xref.encrypt ? false :
                this.xref.encrypt.encryptMetadata;

            var stream = this.xref.fetch(streamRef, !encryptMetadata);
            var metadata;
            if (stream && isDict(stream.dict)) {
                var type = stream.dict.get('Type');
                var subtype = stream.dict.get('Subtype');

                if (isName(type) && isName(subtype) &&
                    type.name === 'Metadata' && subtype.name === 'XML') {
                    // XXX: This should examine the charset the XML document defines,
                    // however since there are currently no real means to decode
                    // arbitrary charsets, let's just hope that the author of the PDF
                    // was reasonable enough to stick with the XML default charset,
                    // which is UTF-8.
                    try {
                        metadata = stringToUTF8String(bytesToString(stream.getBytes()));
                    } catch (e) {
                        info('Skipping invalid metadata.');
                    }
                }
            }

            return shadow(this, 'metadata', metadata);
        },
        get toplevelPagesDict() {
            var pagesObj = this.catDict.get('Pages');
            assertWellFormed(isDict(pagesObj), 'invalid top-level pages dictionary');
            // shadow the prototype getter
            return shadow(this, 'toplevelPagesDict', pagesObj);
        },
        get documentOutline() {
            var obj = null;
            try {
                obj = this.readDocumentOutline();
            } catch (ex) {
                if (ex instanceof MissingDataException) {
                    throw ex;
                }
                warn('Unable to read document outline');
            }
            return shadow(this, 'documentOutline', obj);
        },
        readDocumentOutline: function Catalog_readDocumentOutline() {
            var xref = this.xref;
            var obj = this.catDict.get('Outlines');
            var root = { items: [] };
            if (isDict(obj)) {
                obj = obj.getRaw('First');
                var processed = new RefSet();
                if (isRef(obj)) {
                    var queue = [
                        {obj: obj, parent: root}
                    ];
                    // to avoid recursion keeping track of the items
                    // in the processed dictionary
                    processed.put(obj);
                    while (queue.length > 0) {
                        var i = queue.shift();
                        var outlineDict = xref.fetchIfRef(i.obj);
                        if (outlineDict === null) {
                            continue;
                        }
                        if (!outlineDict.has('Title')) {
                            error('Invalid outline item');
                        }
                        var dest = outlineDict.get('A');
                        if (dest) {
                            dest = dest.get('D');
                        } else if (outlineDict.has('Dest')) {
                            dest = outlineDict.getRaw('Dest');
                            if (isName(dest)) {
                                dest = dest.name;
                            }
                        }
                        var title = outlineDict.get('Title');
                        var outlineItem = {
                            dest: dest,
                            title: stringToPDFString(title),
                            color: outlineDict.get('C') || [0, 0, 0],
                            count: outlineDict.get('Count'),
                            bold: !!(outlineDict.get('F') & 2),
                            italic: !!(outlineDict.get('F') & 1),
                            items: []
                        };
                        i.parent.items.push(outlineItem);
                        obj = outlineDict.getRaw('First');
                        if (isRef(obj) && !processed.has(obj)) {
                            queue.push({obj: obj, parent: outlineItem});
                            processed.put(obj);
                        }
                        obj = outlineDict.getRaw('Next');
                        if (isRef(obj) && !processed.has(obj)) {
                            queue.push({obj: obj, parent: i.parent});
                            processed.put(obj);
                        }
                    }
                }
            }
            return root.items.length > 0 ? root.items : null;
        },
        get numPages() {
            var obj = this.toplevelPagesDict.get('Count');
            assertWellFormed(
                isInt(obj),
                'page count in top level pages object is not an integer'
            );
            // shadow the prototype getter
            return shadow(this, 'num', obj);
        },
        get destinations() {
            function fetchDestination(dest) {
                return isDict(dest) ? dest.get('D') : dest;
            }

            var xref = this.xref;
            var dests = {}, nameTreeRef, nameDictionaryRef;
            var obj = this.catDict.get('Names');
            if (obj) {
                nameTreeRef = obj.getRaw('Dests');
            } else if (this.catDict.has('Dests')) {
                nameDictionaryRef = this.catDict.get('Dests');
            }

            if (nameDictionaryRef) {
                // reading simple destination dictionary
                obj = nameDictionaryRef;
                obj.forEach(function catalogForEach(key, value) {
                    if (!value) {
                        return;
                    }
                    dests[key] = fetchDestination(value);
                });
            }
            if (nameTreeRef) {
                var nameTree = new NameTree(nameTreeRef, xref);
                var names = nameTree.getAll();
                for (var name in names) {
                    if (!names.hasOwnProperty(name)) {
                        continue;
                    }
                    dests[name] = fetchDestination(names[name]);
                }
            }
            return shadow(this, 'destinations', dests);
        },
        get javaScript() {
            var xref = this.xref;
            var obj = this.catDict.get('Names');

            var javaScript = [];
            if (obj && obj.has('JavaScript')) {
                var nameTree = new NameTree(obj.getRaw('JavaScript'), xref);
                var names = nameTree.getAll();
                for (var name in names) {
                    if (!names.hasOwnProperty(name)) {
                        continue;
                    }
                    // We don't really use the JavaScript right now so this code is
                    // defensive so we don't cause errors on document load.
                    var jsDict = names[name];
                    if (!isDict(jsDict)) {
                        continue;
                    }
                    var type = jsDict.get('S');
                    if (!isName(type) || type.name !== 'JavaScript') {
                        continue;
                    }
                    var js = jsDict.get('JS');
                    if (!isString(js) && !isStream(js)) {
                        continue;
                    }
                    if (isStream(js)) {
                        js = bytesToString(js.getBytes());
                    }
                    javaScript.push(stringToPDFString(js));
                }
            }
            return shadow(this, 'javaScript', javaScript);
        },

        cleanup: function Catalog_cleanup() {
            this.fontCache.forEach(function (font) {
                delete font.sent;
                delete font.translated;
            });
            this.fontCache.clear();
        },

        getPage: function Catalog_getPage(pageIndex) {
            if (!(pageIndex in this.pagePromises)) {
                this.pagePromises[pageIndex] = this.getPageDict(pageIndex).then(
                    function (a) {
                        var dict = a[0];
                        var ref = a[1];
                        return new Page(this.pdfManager, this.xref, pageIndex, dict, ref,
                            this.fontCache);
                    }.bind(this)
                );
            }
            return this.pagePromises[pageIndex];
        },

        getPageDict: function Catalog_getPageDict(pageIndex) {
            var promise = new LegacyPromise();
            var nodesToVisit = [this.catDict.getRaw('Pages')];
            var currentPageIndex = 0;
            var xref = this.xref;

            function next() {
                while (nodesToVisit.length) {
                    var currentNode = nodesToVisit.pop();

                    if (isRef(currentNode)) {
                        xref.fetchAsync(currentNode).then(function (obj) {
                            if ((isDict(obj, 'Page') || (isDict(obj) && !obj.has('Kids')))) {
                                if (pageIndex === currentPageIndex) {
                                    promise.resolve([obj, currentNode]);
                                } else {
                                    currentPageIndex++;
                                    next();
                                }
                                return;
                            }
                            nodesToVisit.push(obj);
                            next();
                        }.bind(this), promise.reject.bind(promise));
                        return;
                    }

                    // must be a child page dictionary
                    assert(
                        isDict(currentNode),
                        'page dictionary kid reference points to wrong type of object'
                    );
                    var count = currentNode.get('Count');
                    // Skip nodes where the page can't be.
                    if (currentPageIndex + count <= pageIndex) {
                        currentPageIndex += count;
                        continue;
                    }

                    var kids = currentNode.get('Kids');
                    assert(isArray(kids), 'page dictionary kids object is not an array');
                    if (count === kids.length) {
                        // Nodes that don't have the page have been skipped and this is the
                        // bottom of the tree which means the page requested must be a
                        // descendant of this pages node. Ideally we would just resolve the
                        // promise with the page ref here, but there is the case where more
                        // pages nodes could link to single a page (see issue 3666 pdf). To
                        // handle this push it back on the queue so if it is a pages node it
                        // will be descended into.
                        nodesToVisit = [kids[pageIndex - currentPageIndex]];
                        currentPageIndex = pageIndex;
                        continue;
                    } else {
                        for (var last = kids.length - 1; last >= 0; last--) {
                            nodesToVisit.push(kids[last]);
                        }
                    }
                }
                promise.reject('Page index ' + pageIndex + ' not found.');
            }

            next();
            return promise;
        },

        getPageIndex: function Catalog_getPageIndex(ref) {
            // The page tree nodes have the count of all the leaves below them. To get
            // how many pages are before we just have to walk up the tree and keep
            // adding the count of siblings to the left of the node.
            var xref = this.xref;

            function pagesBeforeRef(kidRef) {
                var total = 0;
                var parentRef;
                return xref.fetchAsync(kidRef).then(function (node) {
                    if (!node) {
                        return null;
                    }
                    parentRef = node.getRaw('Parent');
                    return node.getAsync('Parent');
                }).then(function (parent) {
                        if (!parent) {
                            return null;
                        }
                        return parent.getAsync('Kids');
                    }).then(function (kids) {
                        if (!kids) {
                            return null;
                        }
                        var kidPromises = [];
                        var found = false;
                        for (var i = 0; i < kids.length; i++) {
                            var kid = kids[i];
                            assert(isRef(kid), 'kids must be an ref');
                            if (kid.num == kidRef.num) {
                                found = true;
                                break;
                            }
                            kidPromises.push(xref.fetchAsync(kid).then(function (kid) {
                                if (kid.has('Count')) {
                                    var count = kid.get('Count');
                                    total += count;
                                } else { // page leaf node
                                    total++;
                                }
                            }));
                        }
                        if (!found) {
                            error('kid ref not found in parents kids');
                        }
                        return Promise.all(kidPromises).then(function () {
                            return [total, parentRef];
                        });
                    });
            }

            var total = 0;

            function next(ref) {
                return pagesBeforeRef(ref).then(function (args) {
                    if (!args) {
                        return total;
                    }
                    var count = args[0];
                    var parentRef = args[1];
                    total += count;
                    return next(parentRef);
                });
            }

            return next(ref);
        }
    };

}
