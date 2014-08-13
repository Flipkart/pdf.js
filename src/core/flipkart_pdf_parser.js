var FKPDFUtil = {
    removeNullfromArray: function (a) {
        for (var i in a) {
            if (a[i] == null) {
                delete a[i]
            }
        }
        ;
        return a;
    }
}
var PdfObjectMapper_FK = {
    Commands: {
        INLINE_IMAGE: "InlineImage",
        DICTIONARY: "Dictionary",
        STREAM: "Stream",
        ARRAY: "Array",
        REF: "Ref",
        REF_SET: "RefSet",
        REF_SET_CACHE: "RefSetCache",
        CMD: "Cmd",
        NAME: "Name",
        STRING: "String",
        SIMPLE_OBJECT: "SimpleObject",
        CIPHER_TRANSFORM_FACTORY: "CipherTransformFactory"
    }


};


var PdfObjectParser_FK = {
    PDF_FK:Object.create(null),
    createInstance: function (meta) {
        var trailerDict;
        if (!recoveryMode) {
            trailerDict = this.readXRef();
        } else {
            warn('Indexing all PDF objects');
            trailerDict = this.indexObjects();
        }
        trailerDict.assignXref(this);
        this.trailer = trailerDict;
        var encrypt = trailerDict.get('Encrypt');
        if (encrypt) {
            var ids = trailerDict.get('ID');
            var fileId = (ids && ids.length) ? ids[0] : '';
            this.encrypt = new CipherTransformFactory(
                encrypt, fileId, this.password);
        }

        // get the root dictionary (catalog) object
        if (!(this.root = trailerDict.get('Root'))) {
            error('Invalid root reference');
        }
    },
    deserializeXref: function (xrefDummy) {
        var xRef = new XRef();
        for (var prp in xrefDummy) {
            switch (prp) {
                case "cache":
                    this.deserializeXRefCache(xrefDummy["cache"], xRef);
                    break;
                case "encrypt":
                    xRef["encrypt"] = new CipherTransformFactory(this.deserializeDict(xrefDummy["encrypt"]["dict"], xRef), xrefDummy["encrypt"]["fileId"], xrefDummy["encrypt"]["password"]);
                    break;
                case "entries":
                    xRef["entries"] = xrefDummy["entries"];
                    break;
                case "root":
                    xRef["root"] = this.deserializeDict(xrefDummy["root"], xRef);
                    break;
                case "trailer":
                    xRef["trailer"] = this.deserializeDict(xrefDummy["trailer"], xRef);
                    break;
                case "topDict":
                    xRef["topDict"] = this.deserializeDict(xrefDummy["topDict"], xRef);
                    break;
                case "startXRefQueue":
                    xRef["startXRefQueue"] = xrefDummy["startXRefQueue"];
                    break;
                case "xrefstms":
                    xRef["xrefstms"] = xrefDummy["xrefstms"];
                    break;
            }
        }
        return xRef;
    },
    deserializeXRefCache: function (cacheObj, xref) {
        cacheObj = FKPDFUtil.removeNullfromArray(cacheObj);
        for (var prp in cacheObj) {
            xref.cache[prp] = this.deserializeDict(cacheObj[prp], xref);
        }
    },
    deserializeDict: function (dictObj, xref) {
        var dict = new Dict(xref);
        if (dictObj["map"]) {
            for (var prp in dictObj["map"]) {
                dict["map"][prp] = this.deserializeObject(dictObj["map"][prp], xref);
            }
        }
        return dict;
    },
    deserializeObject: function (dummyObj, xref) {
        if(!dummyObj)return dummyObj;
        if (dummyObj instanceof Array) {
            dummyObj = FKPDFUtil.removeNullfromArray(dummyObj);
            var objArr = [];
            for (var prp in dummyObj) {
                if (!(dummyObj[prp] instanceof Function))
                    objArr[prp] = this.deserializeObject(dummyObj[prp]);
            }
            return objArr;
        }
        else if (dummyObj["objectType"]) {
            var objectType = dummyObj["objectType"];
            switch (objectType) {
                case PdfObjectMapper_FK.Commands.DICTIONARY:
                    return this.deserializeDict(dummyObj, xref);
                    break;
                case  PdfObjectMapper_FK.Commands.NAME:
                    return new Name(dummyObj["name"]);
                    break;
                case  PdfObjectMapper_FK.Commands.CMD:
                    return new Cmd(dummyObj["cmd"]);
                    break;
                case  PdfObjectMapper_FK.Commands.REF:
                    return new Ref(dummyObj["num"], dummyObj["gen"]);
                    break;
                case  PdfObjectMapper_FK.Commands.REF_SET:
                    var refSet = new RefSet();
                    refSet["dict"] = objectType.dict;
                    return refSet;
                    break;
                case  PdfObjectMapper_FK.Commands.CIPHER_TRANSFORM_FACTORY:
                    var cipherFactory = new CipherTransformFactory(this.deserializeDict(dummyObj["dict"], xref), dummyObj["fileId"], dummyObj["password"]);
                    return cipherFactory;
                    break;
                case  PdfObjectMapper_FK.Commands.REF_SET_CACHE:
                    var refSetCache = new RefSetCache();
                    refSetCache["dict"] = objectType.dict;
                    return refSetCache;
                    break;
                default:
                    return dummyObj;
            }
        }
        else {
            return dummyObj;
        }
    },
    deserializeSpecificObject:function(dummyObj,xRef){
        var tempObj=Object.create(null);
        for (var prp in dummyObj) {
            if (!(dummyObj[prp] instanceof Function))
                tempObj[prp] = this.deserializeObject(dummyObj[prp],xRef);
        }
        return tempObj;
    },
    serializeXref: function (xref) {
        var xRefCopy = Object.create(null);
        var serializeProperties = ["cache", "root", "topDict", "trailer", "encrypt"];
        for (var prp in xref) {
            var value=xref[prp];
            if (!(value instanceof Function) && !(value instanceof Stream)
                && !(value instanceof ChunkedStream)) {
                if (serializeProperties.indexOf(prp) != -1)
                    xRefCopy[prp] = this.serializeObject(value);
                else
                    xRefCopy[prp] = xref[prp];
            }
        }
        return xRefCopy;
    },
    serializeObject: function (obj) {
        if (isDict(obj)) {
            var dictDummy = Object.create(null);
            if (obj["map"]) {
                dictDummy["map"] = Object.create(null);
                for (var prp in obj["map"]) {
                    if (!(obj["map"][prp] instanceof Function)) {
                        dictDummy["map"][prp] = this.serializeObject(obj["map"][prp]);
                    }
                }
            }
            dictDummy["objectType"] = PdfObjectMapper_FK.Commands.DICTIONARY;
            return dictDummy;
        } else if (obj instanceof CipherTransformFactory) {
            var encryptDummy = Object.create(null);
            for (var prp in obj) {
                if (!(obj[prp] instanceof Function)) {
                    encryptDummy[prp] = this.serializeObject(obj[prp]);
                }
            }
            encryptDummy["objectType"] = PdfObjectMapper_FK.Commands.CIPHER_TRANSFORM_FACTORY;
            return encryptDummy;
        }
        else if (isArray(obj)) {
//            obj = FKPDFUtil.removeNullfromArray(obj);
            var jsonArray = [];
            for (var index in obj) {
                if (!(obj[index] instanceof Function)) {
                    jsonArray[index] = this.serializeObject(obj[index]);
                }
            }
            return jsonArray;
        } else if (isRef(obj)) {
            obj["objectType"] = PdfObjectMapper_FK.Commands.REF;
            return JSON.parse(JSON.stringify(obj));
        } else if (obj instanceof RefSet) {
            obj["objectType"] = PdfObjectMapper_FK.Commands.REF_SET;
            return JSON.parse(JSON.stringify(obj));
        } else if (obj instanceof RefSetCache) {
            obj["objectType"] = PdfObjectMapper_FK.Commands.REF_SET_CACHE;
            return JSON.parse(JSON.stringify(obj));
        }
        else if (isName(obj)) {
            obj["objectType"] = PdfObjectMapper_FK.Commands.NAME;
            return JSON.parse(JSON.stringify(obj));
        }
        else if (isCmd(obj)) {
            obj["objectType"] = PdfObjectMapper_FK.Commands.CMD;
            return JSON.parse(JSON.stringify(obj));
        } else if (obj instanceof XRef) {
            console.error("found xref within xref ::" + obj);
            return;
        } else if(obj instanceof Object){
            var dummyObj={};
            for (var prp in obj) {
                if (!(obj[prp] instanceof Function)) {
                    dummyObj[prp] = this.serializeObject(obj[prp]);
                }
            }
            return dummyObj;
        }else {
            return obj;
        }
    },
    serializeCatalog: function (catalog) {
        var catalogCopy = Object.create(null);
        var serializeProperties = ["documentOutline", "metadata","toplevelPagesDict","numPages","destinations","javaScript"];
        for(var index in serializeProperties){
            var value=catalog[serializeProperties[index]];
            catalogCopy[serializeProperties[index]] = this.serializeObject(value);
        }
        return catalogCopy;
    },
    deserializeCatalog:function(catalog,xref){
        return {
            "metadata":PdfObjectParser_FK.deserializeObject(catalog["metadata"],xref),
            "toplevelPagesDict":PdfObjectParser_FK.deserializeObject(catalog["toplevelPagesDict"],xref),
            "numPages":PdfObjectParser_FK.deserializeObject(catalog["numPages"],xref),
            "destinations":PdfObjectParser_FK.deserializeSpecificObject(catalog["destinations"],xref),
            "javaScript":PdfObjectParser_FK.deserializeObject(catalog["javaScript"],xref),
            "documentOutline":PdfObjectParser_FK.deserializeObject(catalog["documentOutline"],xref)
        };
    }
}
