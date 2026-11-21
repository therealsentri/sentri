import 'package:firebase_core/firebase_core.dart';

/// Firebase wiring for the two apps registered in the "TheSentri" project
/// (thesentri-5fbeb). Android and iOS are separate apps inside the same project,
/// so Firebase issues each a distinct app id; both use bundle/package id
/// ng.sentri.sentri.
///
/// These values are plain identifiers - every Firebase app ships them in its
/// google-services.json / GoogleService-Info.plist, and Google's own docs treat
/// them as public (they identify the app to Firebase, they do not authorize
/// anything). They live here instead of those files because the CI build has no
/// step to install native config files, and missing them used to make
/// Firebase.initializeApp() throw - which silently disabled push on every
/// installed phone.
const FirebaseOptions kFirebaseAndroidOptions = FirebaseOptions(
  apiKey: 'AIzaSyCyBZn-6CL4ahooP3-uT3V1hhAiuZxDIDo',
  appId: '1:299291672707:android:d1692c705c8c90b43e5bb6',
  messagingSenderId: '299291672707',
  projectId: 'thesentri-5fbeb',
  storageBucket: 'thesentri-5fbeb.firebasestorage.app',
);

const FirebaseOptions kFirebaseIosOptions = FirebaseOptions(
  apiKey: 'AIzaSyAbJ3vYodDNUbhoVxi-kT4n-qfp1FLFvoA',
  appId: '1:299291672707:ios:79381a7a0c850c4d3e5bb6',
  messagingSenderId: '299291672707',
  projectId: 'thesentri-5fbeb',
  storageBucket: 'thesentri-5fbeb.firebasestorage.app',
  iosBundleId: 'ng.sentri.sentri',
);
